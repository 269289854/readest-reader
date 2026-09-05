import {
  BaseDirectory,
  exists,
  mkdir,
  readFile,
  writeFile,
  writeTextFile,
} from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';

import type { MokeRemoteBookSource } from '@/types/book';

const CACHE_ROOT = 'moke-reader-cache/v1';
const touchedAt = new Map<string, number>();
const ACCESS_TOUCH_INTERVAL_MS = 60_000;

function fnv1a(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function opaqueId(value: string): string {
  return fnv1a(value, 0x811c9dc5) + fnv1a(value, 0x9e3779b9);
}

export function mokeRemoteVersionKey({
  etag,
  lastModified,
  size,
}: {
  etag?: string | null;
  lastModified?: string | null;
  size: number;
}): string {
  return opaqueId(`${etag || ''}\n${lastModified || ''}\n${size}`);
}

function sourceKey(source: MokeRemoteBookSource): string {
  return opaqueId(`${source.cacheScope}\n${source.identity}`);
}

function chunkPaths(source: MokeRemoteBookSource, versionKey: string, start: number) {
  const dir = `${CACHE_ROOT}/${source.cacheScope}/${sourceKey(source)}/${versionKey}`;
  const stem = `${dir}/${start}`;
  return { dir, data: `${stem}.bin`, access: `${stem}.atime` };
}

async function touchAccess(path: string): Promise<void> {
  const now = Date.now();
  if (now - (touchedAt.get(path) || 0) < ACCESS_TOUCH_INTERVAL_MS) return;
  touchedAt.set(path, now);
  try {
    await writeTextFile(path, String(now), { baseDir: BaseDirectory.AppCache });
  } catch {
    // A cache hit must remain usable even if its LRU marker cannot be updated.
  }
}

export async function readMokeRemoteChunk(
  source: MokeRemoteBookSource,
  versionKey: string,
  start: number,
  expectedBytes: number,
): Promise<ArrayBuffer | null> {
  const paths = chunkPaths(source, versionKey, start);
  try {
    if (!(await exists(paths.data, { baseDir: BaseDirectory.AppCache }))) return null;
    const data = await readFile(paths.data, { baseDir: BaseDirectory.AppCache });
    if (data.byteLength !== expectedBytes) return null;
    void touchAccess(paths.access);
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  } catch {
    return null;
  }
}

export async function writeMokeRemoteChunk(
  source: MokeRemoteBookSource,
  versionKey: string,
  start: number,
  data: ArrayBuffer,
): Promise<void> {
  const paths = chunkPaths(source, versionKey, start);
  try {
    await mkdir(paths.dir, { baseDir: BaseDirectory.AppCache, recursive: true });
    await writeFile(paths.data, new Uint8Array(data), { baseDir: BaseDirectory.AppCache });
    await writeTextFile(paths.access, String(Date.now()), { baseDir: BaseDirectory.AppCache });
    void invoke('moke_trim_reader_cache', { maxBytes: source.cacheLimitBytes }).catch(
      () => undefined,
    );
  } catch {
    // Disk caching is opportunistic; the network bytes have already been returned.
  }
}
