import { describe, expect, it } from 'vitest';

import { makeMokeSourceBook, parseMokeBookSource } from '@/helpers/mokeBookSource';
import type { MokeLocalBookSource, MokeRemoteBookSource } from '@/types/book';

const base = {
  identity: 'moke0123456789abcdef',
  cacheScope: '0123456789abcdef',
  cacheLimitBytes: 384 * 1024 * 1024,
  bookId: '42',
  format: 'epub' as const,
  title: 'Sample',
  author: 'Author',
};

describe('makeMokeSourceBook', () => {
  it('uses the shared source identity directly without hashing or importing a local file', () => {
    const source: MokeLocalBookSource = {
      ...base,
      kind: 'local',
      filePath: 'C:\\Books\\sample.epub',
      fileVersion: 'etag-v1',
    };

    const book = makeMokeSourceBook(source, 1234);

    expect(book).toMatchObject({
      hash: source.identity,
      format: 'EPUB',
      filePath: source.filePath,
      mokeSource: source,
      downloadedAt: 1234,
      deletedAt: 1234,
    });
  });

  it('keeps the same hash for the matching remote source and carries only its authenticated URL', () => {
    const source: MokeRemoteBookSource = {
      ...base,
      kind: 'remote',
      serverUrl: 'https://books.test',
      url: 'https://books.test/api/book/42.epub?mode=read',
    };

    const book = makeMokeSourceBook(source, 5678);

    expect(book.hash).toBe(base.identity);
    expect(book.url).toBe(source.url);
    expect(book.filePath).toBeUndefined();
    expect(book.downloadedAt).toBeNull();
  });

  it('accepts only the account-scoped TaleBook read endpoint on the configured server', () => {
    const source: MokeRemoteBookSource = {
      ...base,
      kind: 'remote',
      serverUrl: 'https://books.test',
      url: 'https://books.test/api/book/42.epub?mode=read',
    };
    expect(parseMokeBookSource(source)).toEqual(source);
    expect(
      parseMokeBookSource({ ...source, url: 'https://other.test/api/book/42.epub?mode=read' }),
    ).toBeNull();
    expect(
      parseMokeBookSource({ ...source, url: 'https://books.test/api/book/42.epub' }),
    ).toBeNull();
    expect(parseMokeBookSource({ ...source, cacheScope: '../outside' })).toBeNull();
  });
});
