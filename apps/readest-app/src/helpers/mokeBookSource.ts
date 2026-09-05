import type { Book, BookFormat, MokeBookSource, MokeRemoteBookSource } from '@/types/book';

const MIN_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_BYTES = 4 * 1024 * 1024 * 1024;

function isAllowedRemoteSource(
  serverUrl: string,
  sourceUrl: string,
  bookId: string,
  format: string,
): boolean {
  try {
    const server = new URL(serverUrl);
    const source = new URL(sourceUrl);
    if (!['http:', 'https:'].includes(server.protocol)) return false;
    if (server.username || server.password || server.search || server.hash) return false;
    if (source.username || source.password || source.hash || source.origin !== server.origin) {
      return false;
    }
    const expected = new URL(server.href);
    expected.pathname = `${expected.pathname.replace(/\/+$/, '')}/api/book/${bookId}.${format}`;
    expected.search = '?mode=read';
    return source.href === expected.href;
  } catch {
    return false;
  }
}

export function parseMokeBookSource(value: unknown): MokeBookSource | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Partial<MokeBookSource>;
  if (
    (source.kind !== 'local' && source.kind !== 'remote') ||
    typeof source.identity !== 'string' ||
    !/^moke[0-9a-f]{16}$/.test(source.identity) ||
    typeof source.cacheScope !== 'string' ||
    !/^[0-9a-f]{16}$/.test(source.cacheScope) ||
    typeof source.bookId !== 'string' ||
    !/^\d+$/.test(source.bookId) ||
    typeof source.format !== 'string' ||
    !/^[a-z0-9]{1,16}$/i.test(source.format) ||
    typeof source.title !== 'string' ||
    typeof source.author !== 'string' ||
    typeof source.cacheLimitBytes !== 'number' ||
    !Number.isSafeInteger(source.cacheLimitBytes) ||
    source.cacheLimitBytes < MIN_CACHE_BYTES ||
    source.cacheLimitBytes > MAX_CACHE_BYTES
  ) {
    return null;
  }
  if (source.kind === 'local') {
    return typeof source.filePath === 'string' && source.filePath.length > 0
      ? (source as MokeBookSource)
      : null;
  }
  const remote = source as Partial<MokeRemoteBookSource>;
  return remote.format === 'epub' || remote.format === 'pdf'
    ? typeof remote.serverUrl === 'string' &&
      typeof remote.url === 'string' &&
      isAllowedRemoteSource(remote.serverUrl, remote.url, remote.bookId!, remote.format)
      ? (remote as MokeBookSource)
      : null
    : null;
}

export function makeMokeSourceBook(source: MokeBookSource, now = Date.now()): Book {
  const format = source.format.toUpperCase() as BookFormat;
  return {
    hash: source.identity,
    format,
    title: source.title || `Book ${source.bookId}`,
    sourceTitle: source.title || `Book ${source.bookId}`,
    author: source.author || '',
    createdAt: now,
    updatedAt: now,
    downloadedAt: source.kind === 'local' ? now : null,
    deletedAt: now,
    filePath: source.kind === 'local' ? source.filePath : undefined,
    url: source.kind === 'remote' ? source.url : undefined,
    mokeSource: source,
  };
}
