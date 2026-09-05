import { FileHandle, open, BaseDirectory, SeekMode } from '@tauri-apps/plugin-fs';
import { getOSPlatform } from './misc';
import type { MokeRemoteBookSource } from '@/types/book';
import {
  mokeRemoteVersionKey,
  readMokeRemoteChunk,
  writeMokeRemoteChunk,
} from '@/services/mokeRemoteCache';

interface MokeRemoteMemoryCache {
  cacheScope: string;
  clearMemoryCache(): void;
}

const mokeRemoteFiles = new Set<MokeRemoteMemoryCache>();
let cacheClearListenerStarted = false;

function registerMokeRemoteFile(file: MokeRemoteMemoryCache): void {
  mokeRemoteFiles.add(file);
  if (cacheClearListenerStarted) return;
  cacheClearListenerStarted = true;
  void import('@tauri-apps/api/event')
    .then(({ listen }) =>
      listen<string | null>('moke-reader-cache-cleared', ({ payload }) => {
        for (const remote of mokeRemoteFiles) {
          if (!payload || remote.cacheScope === payload) remote.clearMemoryCache();
        }
      }),
    )
    .catch(() => {
      cacheClearListenerStarted = false;
    });
}

function isMokeAuthenticationResponse(response: Response): boolean {
  return (
    response.status === 401 ||
    response.status === 403 ||
    /text\/html/i.test(response.headers.get('content-type') || '')
  );
}

class DeferredBlob extends Blob {
  #dataPromise: Promise<ArrayBuffer>;
  #type: string;

  constructor(dataPromise: Promise<ArrayBuffer>, type: string) {
    super();
    this.#dataPromise = dataPromise;
    this.#type = type;
  }

  override async arrayBuffer() {
    const data = await this.#dataPromise;
    return data;
  }

  override async text() {
    const data = await this.#dataPromise;
    return new TextDecoder().decode(data);
  }

  override stream() {
    return new ReadableStream({
      start: async (controller) => {
        const data = await this.#dataPromise;
        const reader = new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(data));
            controller.close();
          },
        }).getReader();
        const pump = () =>
          reader.read().then(({ done, value }): Promise<void> => {
            if (done) {
              controller.close();
              return Promise.resolve();
            }
            controller.enqueue(value);
            return pump();
          });
        return pump();
      },
    });
  }

  override get type() {
    return this.#type;
  }
}

export interface ClosableFile extends File {
  open(): Promise<this>;
  close(): Promise<void>;
}

export class NativeFile extends File implements ClosableFile {
  #handle: FileHandle | null = null;
  #fp: string;
  #name: string;
  #baseDir: BaseDirectory | null;
  #lastModified: number = 0;
  #size: number = -1;
  #type: string = '';

  static MAX_CACHE_CHUNK_SIZE = 1024 * 1024;
  static MAX_CACHE_ITEMS_SIZE = 50;
  #order: number[] = [];
  #cache: Map<number, ArrayBuffer> = new Map();
  #pendingReads: Map<string, Promise<ArrayBuffer>> = new Map();

  constructor(fp: string, name?: string, baseDir: BaseDirectory | null = null, type = '') {
    super([], name || fp, { type });
    this.#fp = fp;
    this.#baseDir = baseDir;
    this.#name = name || fp;
  }

  async open() {
    this.#handle = await open(this.#fp, this.#baseDir ? { baseDir: this.#baseDir } : undefined);
    const stats = await this.#handle.stat();
    this.#size = stats.size;
    this.#lastModified = stats.mtime ? stats.mtime.getTime() : Date.now();
    return this;
  }

  async close() {
    if (this.#handle) {
      await this.#handle.close();
      this.#handle = null;
    }
    this.#cache.clear();
    this.#order = [];
  }

  override get name() {
    return this.#name;
  }

  override get type() {
    return this.#type;
  }

  override get size() {
    return this.#size;
  }

  override get lastModified() {
    return this.#lastModified;
  }

  getNativeLocation(): { path: string; baseDir: BaseDirectory | null } {
    return { path: this.#fp, baseDir: this.#baseDir };
  }

  async stat() {
    return this.#handle?.stat();
  }

  async seek(offset: number, whence: SeekMode): Promise<number> {
    if (!this.#handle) {
      throw new Error('File handle is not open');
    }
    return this.#handle.seek(offset, whence);
  }

  // exclusive reading of the end: [start, end)
  async readData(start: number, end: number): Promise<ArrayBuffer> {
    start = Math.max(0, start);
    end = Math.max(start, Math.min(this.size, end));
    const size = end - start;

    if (size > NativeFile.MAX_CACHE_CHUNK_SIZE) {
      const handle = await open(this.#fp, this.#baseDir ? { baseDir: this.#baseDir } : undefined);
      try {
        await handle.seek(start, SeekMode.Start);
        const buffer = new Uint8Array(size);
        await handle.read(buffer);
        return buffer.buffer;
      } finally {
        await handle.close();
      }
    }

    const cachedChunkStart = Array.from(this.#cache.keys()).find((chunkStart) => {
      const buffer = this.#cache.get(chunkStart)!;
      return start >= chunkStart && end <= chunkStart + buffer.byteLength;
    });

    if (cachedChunkStart !== undefined) {
      this.#updateAccessOrder(cachedChunkStart);
      const buffer = this.#cache.get(cachedChunkStart)!;
      const offset = start - cachedChunkStart;
      return buffer.slice(offset, offset + size);
    }

    const readKey = `${start}-${end}`;
    const pendingRead = this.#pendingReads.get(readKey);

    if (pendingRead) {
      return pendingRead;
    }

    const readPromise = this.#readAndCacheChunkSafe(start, size);
    this.#pendingReads.set(readKey, readPromise);

    try {
      return await readPromise;
    } finally {
      this.#pendingReads.delete(readKey);
    }
  }

  async #readAndCacheChunkSafe(start: number, size: number): Promise<ArrayBuffer> {
    const handle = await open(this.#fp, this.#baseDir ? { baseDir: this.#baseDir } : undefined);
    try {
      const chunkStart = Math.max(0, start - 1024);
      const chunkEnd = Math.min(this.size, start + NativeFile.MAX_CACHE_CHUNK_SIZE);
      const chunkSize = chunkEnd - chunkStart;

      await handle.seek(chunkStart, SeekMode.Start);
      const buffer = new Uint8Array(chunkSize);
      await handle.read(buffer);

      // Only one thread reaches here per unique range
      this.#cache.set(chunkStart, buffer.buffer);
      this.#updateAccessOrder(chunkStart);
      this.#ensureCacheSize();

      const offset = start - chunkStart;
      return buffer.buffer.slice(offset, offset + size);
    } finally {
      await handle.close();
    }
  }

  #updateAccessOrder(chunkStart: number) {
    const index = this.#order.indexOf(chunkStart);
    if (index > -1) {
      this.#order.splice(index, 1);
    }
    this.#order.unshift(chunkStart);
  }

  #ensureCacheSize() {
    while (this.#cache.size > NativeFile.MAX_CACHE_ITEMS_SIZE) {
      const oldestKey = this.#order.pop();
      if (oldestKey !== undefined) {
        this.#cache.delete(oldestKey);
      }
    }
  }

  override slice(start = 0, end = this.size, contentType = this.type): Blob {
    // console.log(`Slicing: ${start}-${end}, size: ${end - start}`);
    const dataPromise = this.readData(start, end);
    return new DeferredBlob(dataPromise, contentType);
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    const CHUNK_SIZE = 1024 * 1024;
    let offset = 0;
    let streamHandle: FileHandle | null = null;
    let streamClosed = false;

    const ensureHandle = async () => {
      if (streamHandle) return streamHandle;
      streamHandle = await open(this.#fp, this.#baseDir ? { baseDir: this.#baseDir } : undefined);
      streamClosed = false;
      return streamHandle;
    };

    const closeHandle = async () => {
      if (!streamHandle || streamClosed) return;
      await streamHandle.close();
      streamClosed = true;
      streamHandle = null;
    };

    return new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull: async (controller) => {
        const handle = await ensureHandle();

        if (offset >= this.size) {
          await closeHandle();
          controller.close();
          return;
        }

        const end = Math.min(offset + CHUNK_SIZE, this.size);
        const buffer = new Uint8Array(end - offset);

        await handle.seek(offset, SeekMode.Start);
        const bytesRead = await handle.read(buffer);

        if (bytesRead === null || bytesRead === 0) {
          await closeHandle();
          controller.close();
          return;
        }

        controller.enqueue(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      },

      cancel: async () => {
        await closeHandle();
      },
    });
  }

  override async text() {
    const blob = this.slice(0, this.size);
    return blob.text();
  }

  override async arrayBuffer() {
    const blob = this.slice(0, this.size);
    return blob.arrayBuffer();
  }
}

export class RemoteFile extends File implements ClosableFile {
  url: string;
  #name: string;
  #lastModified: number;
  #size: number = -1;
  #type: string = '';
  #order: number[] = [];
  #cache: Map<number, ArrayBuffer> = new Map(); // LRU cache
  #pendingFetches: Map<string, Promise<ArrayBuffer>> = new Map();
  // When true, byte ranges are carried in the URL query (?start=&end=) instead
  // of a `Range` header — see fromNativePath().
  #queryRange = false;
  #mokeSource?: MokeRemoteBookSource;
  #versionKey = '';
  #etag = '';
  #lastModifiedHeader = '';

  static MAX_CACHE_CHUNK_SIZE = 1024 * 128;
  static MAX_CACHE_ITEMS_SIZE: number = 128;
  static RANGE_SCHEME_ORIGIN = 'http://rangefile.localhost';
  static RANGE_FETCH_TIMEOUT_MS = 15_000;

  constructor(
    url: string,
    name?: string,
    type = '',
    lastModified = Date.now(),
    options?: { mokeSource?: MokeRemoteBookSource },
  ) {
    const basename = url.split('/').pop() || 'remote-file';
    super([], name || basename, { type, lastModified });
    this.url = url;
    this.#name = name || basename;
    this.#type = type;
    this.#lastModified = lastModified;
    this.#mokeSource = options?.mokeSource;
    if (this.#mokeSource) registerMokeRemoteFile(this);
  }

  /**
   * Read a local file path through the `rangefile` custom URI scheme, carrying
   * the byte range in the URL query (`?path=&start=&end=`) rather than a
   * `Range` request header.
   *
   * On Android the WebView re-applies a `Range` header's offset to the body
   * returned from an intercepted custom protocol (Chromium 40739128;
   * tauri-apps/tauri#12019, #3725), corrupting any non-zero-start read — so the
   * asset protocol can't back `RemoteFile` there. A query-carried range has no
   * `Range` header, so the WebView delivers the 200 body verbatim while the
   * bytes still stream through the network stack (not the slow Tauri IPC
   * bridge). The Rust handler is scope-gated by `asset_protocol_scope`.
   */
  static fromNativePath(absolutePath: string, name?: string): RemoteFile {
    const url = `${RemoteFile.RANGE_SCHEME_ORIGIN}/?path=${encodeURIComponent(absolutePath)}`;
    const file = new RemoteFile(url, name);
    file.#queryRange = true;
    return file;
  }

  override get name() {
    return this.#name;
  }

  override get type() {
    return this.#type;
  }

  override get size() {
    return this.#size;
  }

  override get lastModified() {
    return this.#lastModified;
  }

  async _open_with_head() {
    const response = await fetch(this.url, { method: 'HEAD' });
    if (!response.ok) {
      throw new Error(`Failed to fetch file size: ${response.status}`);
    }
    this.#size = Number(response.headers.get('content-length'));
    this.#type = response.headers.get('content-type') || '';
    return this;
  }

  async #authenticatedFetch(url: string, init: RequestInit): Promise<Response> {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
    const controller = new AbortController();
    const parentSignal = init.signal;
    const abortFromParent = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) {
      abortFromParent();
    } else {
      parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    }
    const timeout = setTimeout(
      () => controller.abort('moke.remote.timeout'),
      RemoteFile.RANGE_FETCH_TIMEOUT_MS,
    );
    try {
      return await tauriFetch(url, {
        ...init,
        signal: controller.signal,
        credentials: 'include',
        maxRedirections: 10,
        danger: {
          acceptInvalidCerts: true,
          acceptInvalidHostnames: true,
        },
      } as Parameters<typeof tauriFetch>[1]);
    } catch (error) {
      if (controller.signal.aborted && !parentSignal?.aborted) {
        throw new Error('moke.remote.timeout', { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
    }
  }

  async #cancelResponseBody(response: Response): Promise<void> {
    try {
      await response.body?.cancel();
    } catch {
      // The body may already be closed or locked. Either state is safe here.
    }
  }

  async #readResponseBuffer(response: Response): Promise<ArrayBuffer> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        response.arrayBuffer(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            void this.#cancelResponseBody(response);
            reject(new Error('moke.remote.timeout'));
          }, RemoteFile.RANGE_FETCH_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async #openMokeRemote() {
    const parseTotalSize = (contentRange: string): number => {
      const match = contentRange.match(/^bytes\s+(?:\d+-\d+|\*)\/(\d+)$/i);
      return match ? Number(match[1]) : Number.NaN;
    };

    const head = await this.#authenticatedFetch(this.url, { method: 'HEAD' });
    const headContentRange = head.headers.get('content-range') || '';
    const headContentLength = Number(head.headers.get('content-length'));
    const headTotalSize = parseTotalSize(headContentRange);
    const headSupportsRanges = /\bbytes\b/i.test(head.headers.get('accept-ranges') || '');
    const headMetadata = {
      contentType: head.headers.get('content-type') || '',
      etag: head.headers.get('etag') || '',
      lastModified: head.headers.get('last-modified') || '',
    };
    const headAuthenticationRequired = isMokeAuthenticationResponse(head);
    await this.#cancelResponseBody(head);
    if (headAuthenticationRequired) throw new Error('moke.remote.authentication_required');

    let size = Number.NaN;
    let metadata = headMetadata;
    if (
      head.status === 200 &&
      !headContentRange &&
      headSupportsRanges &&
      Number.isSafeInteger(headContentLength) &&
      headContentLength > 0
    ) {
      size = headContentLength;
    } else if (
      head.status === 206 &&
      Number.isSafeInteger(headTotalSize) &&
      headTotalSize > 0
    ) {
      // A retained Range header can turn HEAD into 206. Content-Length is only
      // the partial length in that case; Content-Range carries the real size.
      size = headTotalSize;
    }

    if (!Number.isSafeInteger(size) || size <= 0) {
      const probe = await this.#authenticatedFetch(this.url, {
        headers: { Range: 'bytes=0-0', 'Accept-Encoding': 'identity' },
      });
      if (isMokeAuthenticationResponse(probe)) {
        await this.#cancelResponseBody(probe);
        throw new Error('moke.remote.authentication_required');
      }
      if (probe.status !== 206) {
        await this.#cancelResponseBody(probe);
        throw new Error('moke.remote.range_unsupported');
      }
      const contentRange = probe.headers.get('content-range') || '';
      const match = contentRange.match(/^bytes 0-0\/(\d+)$/i);
      const body = await this.#readResponseBuffer(probe);
      if (!match || body.byteLength !== 1) throw new Error('moke.remote.range_invalid');
      size = Number(match[1]);
      metadata = {
        contentType: probe.headers.get('content-type') || headMetadata.contentType,
        etag: probe.headers.get('etag') || headMetadata.etag,
        lastModified: probe.headers.get('last-modified') || headMetadata.lastModified,
      };
    }

    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('moke.remote.size_invalid');

    this.#size = size;
    this.#type = metadata.contentType;
    this.#etag = metadata.etag;
    this.#lastModifiedHeader = metadata.lastModified;
    const parsedModified = Date.parse(this.#lastModifiedHeader);
    if (Number.isFinite(parsedModified)) this.#lastModified = parsedModified;
    this.#versionKey = mokeRemoteVersionKey({
      etag: this.#etag,
      lastModified: this.#lastModifiedHeader,
      size,
    });
    return this;
  }

  async _open_with_range() {
    const response = await fetch(this.url, { headers: { Range: `bytes=${0}-${1023}` } });
    if (!response.ok) {
      throw new Error(`Failed to fetch file size: ${response.status}`);
    }
    this.#size = Number(response.headers.get('content-range')?.split('/')[1]);
    this.#type = response.headers.get('content-type') || '';
    return this;
  }

  async _open_with_query() {
    // No `Range` header — the rangefile handler returns the file size in
    // `X-Total-Size` and the requested bytes as a plain 200 body.
    const response = await this.#fetchQueryRange(`${this.url}&start=0&end=0`);
    if (!response.ok) {
      throw new Error(`Failed to fetch file size: ${response.status}`);
    }
    const sizeHeader = response.headers.get('x-total-size');
    const size = Number(sizeHeader);
    if (
      sizeHeader === null ||
      sizeHeader.trim() === '' ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      throw new Error('Invalid X-Total-Size from rangefile protocol');
    }
    this.#size = size;
    this.#type = response.headers.get('content-type') || '';
    return this;
  }

  async #fetchQueryRange(url: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RemoteFile.RANGE_FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error('Timed out waiting for rangefile protocol response', { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async open() {
    if (this.#mokeSource) return this.#openMokeRemote();
    if (this.#queryRange) {
      return this._open_with_query();
    }
    // FIXME: currently HEAD request in asset protocol is not supported on Android
    if (getOSPlatform() === 'android') {
      return this._open_with_range();
    } else {
      return this._open_with_head();
    }
  }

  async close(): Promise<void> {
    this.clearMemoryCache();
    mokeRemoteFiles.delete(this);
  }

  clearMemoryCache(): void {
    this.#cache.clear();
    this.#order = [];
  }

  get cacheScope(): string {
    return this.#mokeSource?.cacheScope || '';
  }

  async fetchRangePart(start: number, end: number) {
    start = Math.max(0, start);
    end = Math.min(this.size - 1, end);
    // console.log(`Fetching range: ${start}-${end}, size: ${end - start + 1}`);
    const response = this.#queryRange
      ? await this.#fetchQueryRange(`${this.url}&start=${start}&end=${end}`)
      : this.#mokeSource
        ? await this.#authenticatedFetch(this.url, {
            headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' },
          })
        : await fetch(this.url, { headers: { Range: `bytes=${start}-${end}` } });
    if (this.#mokeSource && isMokeAuthenticationResponse(response)) {
      await this.#cancelResponseBody(response);
      throw new Error('moke.remote.authentication_required');
    }
    if (this.#mokeSource && response.status !== 206) {
      await this.#cancelResponseBody(response);
      throw new Error('moke.remote.range_unsupported');
    }
    if (!response.ok) {
      await this.#cancelResponseBody(response);
      throw new Error(`Failed to fetch range: ${response.status}`);
    }
    const buffer = this.#mokeSource
      ? await this.#readResponseBuffer(response)
      : await response.arrayBuffer();
    if (this.#mokeSource) {
      const contentRange = response.headers.get('content-range') || '';
      const match = contentRange.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
      const expected = end - start + 1;
      if (
        !match ||
        Number(match[1]) !== start ||
        Number(match[2]) !== end ||
        Number(match[3]) !== this.size ||
        buffer.byteLength !== expected
      ) {
        throw new Error('moke.remote.range_invalid');
      }
      const responseEtag = response.headers.get('etag') || '';
      if (responseEtag && this.#etag && responseEtag !== this.#etag) {
        this.#etag = responseEtag;
        this.#versionKey = mokeRemoteVersionKey({
          etag: responseEtag,
          lastModified: response.headers.get('last-modified') || this.#lastModifiedHeader,
          size: this.size,
        });
        this.clearMemoryCache();
      }
    }
    return buffer;
  }

  // inclusive reading of the end: [start, end]
  async fetchRange(start: number, end: number): Promise<ArrayBuffer> {
    if (this.#mokeSource) return this.#fetchMokeRange(start, end);

    const rangeSize = end - start + 1;
    const MAX_RANGE_LEN = 1024 * 1000;

    if (rangeSize > MAX_RANGE_LEN) {
      const buffers: ArrayBuffer[] = [];
      for (let currentStart = start; currentStart <= end; currentStart += MAX_RANGE_LEN) {
        const currentEnd = Math.min(currentStart + MAX_RANGE_LEN - 1, end);
        buffers.push(await this.fetchRangePart(currentStart, currentEnd));
      }
      const totalSize = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
      const combinedBuffer = new Uint8Array(totalSize);
      let offset = 0;
      for (const buffer of buffers) {
        combinedBuffer.set(new Uint8Array(buffer), offset);
        offset += buffer.byteLength;
      }
      return combinedBuffer.buffer;
    } else if (rangeSize > RemoteFile.MAX_CACHE_CHUNK_SIZE) {
      return this.fetchRangePart(start, end);
    } else {
      const cachedChunkStart = Array.from(this.#cache.keys()).find((chunkStart) => {
        const buffer = this.#cache.get(chunkStart)!;
        const bufferSize = buffer.byteLength;
        return start >= chunkStart && end <= chunkStart + bufferSize;
      });
      if (cachedChunkStart !== undefined) {
        this.#updateAccessOrder(cachedChunkStart);
        const buffer = this.#cache.get(cachedChunkStart)!;
        const offset = start - cachedChunkStart;
        return buffer.slice(offset, offset + rangeSize);
      }

      const fetchKey = `${start}-${end}`;
      const pendingFetch = this.#pendingFetches.get(fetchKey);

      if (pendingFetch) {
        return pendingFetch;
      }

      const fetchPromise = this.#fetchAndCacheChunkSafe(start, end, rangeSize);
      this.#pendingFetches.set(fetchKey, fetchPromise);
      try {
        return await fetchPromise;
      } finally {
        this.#pendingFetches.delete(fetchKey);
      }
    }
  }

  async #fetchMokeRange(start: number, end: number): Promise<ArrayBuffer> {
    start = Math.max(0, start);
    end = Math.min(this.size - 1, end);
    if (end < start) return new ArrayBuffer(0);

    const output = new Uint8Array(end - start + 1);
    const chunkSize = RemoteFile.MAX_CACHE_CHUNK_SIZE;
    const firstChunk = Math.floor(start / chunkSize) * chunkSize;
    let outputOffset = 0;
    for (let chunkStart = firstChunk; chunkStart <= end; chunkStart += chunkSize) {
      const chunkEnd = Math.min(this.size - 1, chunkStart + chunkSize - 1);
      const chunk = await this.#loadMokeChunk(chunkStart, chunkEnd);
      const copyStart = Math.max(start, chunkStart);
      const copyEnd = Math.min(end, chunkEnd);
      const sourceOffset = copyStart - chunkStart;
      const copyLength = copyEnd - copyStart + 1;
      output.set(new Uint8Array(chunk, sourceOffset, copyLength), outputOffset);
      outputOffset += copyLength;
    }
    return output.buffer;
  }

  async #loadMokeChunk(chunkStart: number, chunkEnd: number): Promise<ArrayBuffer> {
    const cached = this.#cache.get(chunkStart);
    if (cached) {
      this.#updateAccessOrder(chunkStart);
      return cached;
    }

    const source = this.#mokeSource!;
    const expectedBytes = chunkEnd - chunkStart + 1;
    const disk = await readMokeRemoteChunk(source, this.#versionKey, chunkStart, expectedBytes);
    if (disk) {
      this.#cache.set(chunkStart, disk);
      this.#updateAccessOrder(chunkStart);
      this.#ensureCacheSize();
      return disk;
    }

    const fetchKey = `moke:${this.#versionKey}:${chunkStart}`;
    const pending = this.#pendingFetches.get(fetchKey);
    if (pending) return pending;

    const fetchPromise = (async () => {
      const buffer = await this.fetchRangePart(chunkStart, chunkEnd);
      this.#cache.set(chunkStart, buffer);
      this.#updateAccessOrder(chunkStart);
      this.#ensureCacheSize();
      void writeMokeRemoteChunk(source, this.#versionKey, chunkStart, buffer);
      return buffer;
    })();
    this.#pendingFetches.set(fetchKey, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      this.#pendingFetches.delete(fetchKey);
    }
  }

  async #fetchAndCacheChunkSafe(
    start: number,
    end: number,
    rangeSize: number,
  ): Promise<ArrayBuffer> {
    const chunkStart = Math.max(0, start - 1024);
    const chunkEnd = Math.max(end, start + RemoteFile.MAX_CACHE_CHUNK_SIZE - 1024 - 1);
    const buffer = await this.fetchRangePart(chunkStart, chunkEnd);

    // Only one thread reaches here per unique range
    this.#cache.set(chunkStart, buffer);
    this.#updateAccessOrder(chunkStart);
    this.#ensureCacheSize();

    const offset = start - chunkStart;
    return buffer.slice(offset, offset + rangeSize);
  }

  #updateAccessOrder(chunkStart: number) {
    const index = this.#order.indexOf(chunkStart);
    if (index > -1) {
      this.#order.splice(index, 1);
    }
    this.#order.unshift(chunkStart);
  }

  #ensureCacheSize() {
    while (this.#cache.size > RemoteFile.MAX_CACHE_ITEMS_SIZE) {
      const oldestKey = this.#order.pop();
      if (oldestKey !== undefined) {
        this.#cache.delete(oldestKey);
      }
    }
  }

  override slice(start = 0, end = this.size, contentType = this.type): Blob {
    // console.log(`Slicing: ${start}-${end}, size: ${end - start}`);
    const dataPromise = this.fetchRange(start, end - 1);

    return new DeferredBlob(dataPromise, contentType);
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    const CHUNK_SIZE = 1024 * 1024;
    let offset = 0;

    return new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull: async (controller) => {
        if (offset >= this.size) {
          controller.close();
          return;
        }

        const end = Math.min(offset + CHUNK_SIZE, this.size);
        const buffer = await this.fetchRange(offset, end - 1);

        controller.enqueue(new Uint8Array(buffer));
        offset = end;
      },
    });
  }

  override async text() {
    const blob = this.slice(0, this.size);
    return blob.text();
  }

  override async arrayBuffer() {
    const blob = this.slice(0, this.size);
    return blob.arrayBuffer();
  }
}
