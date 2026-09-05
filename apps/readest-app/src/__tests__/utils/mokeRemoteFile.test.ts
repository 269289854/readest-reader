import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  httpFetch: vi.fn(),
  listen: vi.fn(async () => () => {}),
  readChunk: vi.fn(),
  writeChunk: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: mocks.httpFetch }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('@/services/mokeRemoteCache', () => ({
  mokeRemoteVersionKey: ({
    etag,
    lastModified,
    size,
  }: {
    etag?: string | null;
    lastModified?: string | null;
    size: number;
  }) => `${etag || ''}|${lastModified || ''}|${size}`,
  readMokeRemoteChunk: mocks.readChunk,
  writeMokeRemoteChunk: mocks.writeChunk,
}));

import { RemoteFile } from '@/utils/file';
import type { MokeRemoteBookSource } from '@/types/book';

const size = 300_000;
const source: MokeRemoteBookSource = {
  kind: 'remote',
  identity: 'moke0123456789abcdef',
  cacheScope: '0123456789abcdef',
  cacheLimitBytes: 384 * 1024 * 1024,
  bookId: '42',
  format: 'epub',
  title: 'Sample',
  author: 'Author',
  serverUrl: 'https://books.test',
  url: 'https://books.test/api/book/42.epub?mode=read',
};

function headResponse(etag = '"v1"', acceptRanges = 'bytes') {
  return new Response(null, {
    status: 200,
    headers: {
      'accept-ranges': acceptRanges,
      'content-length': String(size),
      'content-type': 'application/epub+zip',
      etag,
    },
  });
}

function partialHeadResponse() {
  return new Response(null, {
    status: 206,
    headers: {
      'accept-ranges': 'bytes',
      'content-length': '1',
      'content-range': `bytes 0-0/${size}`,
      'content-type': 'application/epub+zip',
      etag: '"v1"',
    },
  });
}

function parseRange(init: RequestInit): [number, number] {
  const value = new Headers(init.headers).get('range') || '';
  const match = value.match(/^bytes=(\d+)-(\d+)$/);
  if (!match) throw new Error(`missing range: ${value}`);
  return [Number(match[1]), Number(match[2])];
}

function rangeResponse(
  start: number,
  end: number,
  options: {
    status?: number;
    etag?: string;
    contentRange?: string;
    length?: number;
  } = {},
) {
  const length = options.length ?? end - start + 1;
  return new Response(new Uint8Array(length).fill(start % 251), {
    status: options.status ?? 206,
    headers: {
      'content-range': options.contentRange ?? `bytes ${start}-${end}/${size}`,
      'content-type': 'application/epub+zip',
      etag: options.etag ?? '"v1"',
    },
  });
}

describe('RemoteFile Moke authenticated ranges', () => {
  beforeEach(() => {
    mocks.httpFetch.mockReset();
    mocks.readChunk.mockReset().mockResolvedValue(null);
    mocks.writeChunk.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('aligns to 128KB, carries credentials, and merges concurrent identical ranges', async () => {
    let rangeCalls = 0;
    mocks.httpFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      if (init.method === 'HEAD') return headResponse();
      const [start, end] = parseRange(init);
      rangeCalls++;
      await Promise.resolve();
      return rangeResponse(start, end);
    });
    const file = new RemoteFile(source.url, 'sample.epub', '', 0, { mokeSource: source });
    await file.open();

    const [first, second] = await Promise.all([file.fetchRange(10, 30), file.fetchRange(10, 30)]);

    expect(first.byteLength).toBe(21);
    expect(second.byteLength).toBe(21);
    expect(rangeCalls).toBe(1);
    const rangeInit = mocks.httpFetch.mock.calls.find(([, init]) => init.method !== 'HEAD')?.[1];
    expect(rangeInit.credentials).toBe('include');
    expect(new Headers(rangeInit.headers).get('range')).toBe('bytes=0-131071');
    await file.close();
  });

  it('serves a valid disk chunk without another Range request', async () => {
    mocks.readChunk.mockResolvedValue(new Uint8Array(128 * 1024).buffer);
    mocks.httpFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      if (init.method === 'HEAD') return headResponse();
      throw new Error('unexpected network range');
    });
    const file = new RemoteFile(source.url, 'sample.epub', '', 0, { mokeSource: source });
    await file.open();

    await expect(file.fetchRange(100, 199)).resolves.toHaveProperty('byteLength', 100);
    expect(mocks.httpFetch).toHaveBeenCalledTimes(1);
    await file.close();
  });

  it('rejects a server that ignores Range instead of downloading the full book', async () => {
    mocks.httpFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      if (init.method === 'HEAD') return headResponse();
      const [start, end] = parseRange(init);
      return rangeResponse(start, end, { status: 200 });
    });
    const file = new RemoteFile(source.url, 'sample.epub', '', 0, { mokeSource: source });
    await file.open();

    await expect(file.fetchRange(0, 10)).rejects.toThrow('moke.remote.range_unsupported');
    await file.close();
  });

  it('rejects incorrect Content-Range and byte lengths', async () => {
    mocks.httpFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      if (init.method === 'HEAD') return headResponse();
      const [start, end] = parseRange(init);
      return rangeResponse(start, end, {
        contentRange: `bytes ${start + 1}-${end}/${size}`,
        length: end - start,
      });
    });
    const file = new RemoteFile(source.url, 'sample.epub', '', 0, { mokeSource: source });
    await file.open();

    await expect(file.fetchRange(0, 10)).rejects.toThrow('moke.remote.range_invalid');
    await file.close();
  });

  it('invalidates old in-memory chunks when a later response changes ETag', async () => {
    const starts: number[] = [];
    mocks.httpFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      if (init.method === 'HEAD') return headResponse('"v1"');
      const [start, end] = parseRange(init);
      starts.push(start);
      return rangeResponse(start, end, {
        etag: start === 0 && starts.length === 1 ? '"v1"' : '"v2"',
      });
    });
    const file = new RemoteFile(source.url, 'sample.epub', '', 0, { mokeSource: source });
    await file.open();

    await file.fetchRange(0, 10);
    await file.fetchRange(140_000, 140_010);
    await file.fetchRange(0, 10);

    expect(starts.filter((start) => start === 0)).toHaveLength(2);
    await file.close();
  });

  it('falls back to an authenticated 0-0 probe when HEAD lacks range support', async () => {
    mocks.httpFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      if (init.method === 'HEAD') return headResponse('"v1"', 'none');
      const [start, end] = parseRange(init);
      return rangeResponse(start, end);
    });
    const file = new RemoteFile(source.url, 'sample.epub', '', 0, { mokeSource: source });

    await expect(file.open()).resolves.toBe(file);
    const probeInit = mocks.httpFetch.mock.calls[1]![1];
    expect(new Headers(probeInit.headers).get('range')).toBe('bytes=0-0');
    expect(probeInit.credentials).toBe('include');
    await file.close();
  });

  it('uses Content-Range total when Android returns a partial HEAD response', async () => {
    mocks.httpFetch.mockResolvedValue(partialHeadResponse());
    const file = new RemoteFile(source.url, 'sample.epub', '', 0, { mokeSource: source });

    await expect(file.open()).resolves.toBe(file);
    expect(file.size).toBe(size);
    expect(mocks.httpFetch).toHaveBeenCalledTimes(1);
    await file.close();
  });

  it('releases an unexpected HEAD response body after reading its metadata', async () => {
    const cancel = vi.fn(async () => undefined);
    mocks.httpFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: headResponse().headers,
      body: { cancel },
    } as unknown as Response);
    const file = new RemoteFile(source.url, 'sample.epub', '', 0, { mokeSource: source });

    await file.open();
    expect(cancel).toHaveBeenCalledOnce();
    await file.close();
  });

  it('reports an expired authenticated session instead of a range error', async () => {
    mocks.httpFetch.mockResolvedValue(
      new Response('<html>login</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    const file = new RemoteFile(source.url, 'sample.epub', '', 0, { mokeSource: source });

    await expect(file.open()).rejects.toThrow('moke.remote.authentication_required');
    await file.close();
  });
});
