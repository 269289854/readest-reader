import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  bootstrapMokeLaunchContext,
  mokeProgressStorageKey,
  readPersistedMokeDebugPanel,
} from '@/helpers/mokeLaunchContext';

describe('bootstrapMokeLaunchContext', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, '', '/reader?moke=1&mokeBookId=42');
    window.__MOKE_RESTORE_PROGRESS = null;
  });

  afterEach(() => {
    delete document.documentElement.dataset['mokeReaderTransition'];
    Reflect.deleteProperty(window, 'navigation');
  });

  it('marks a cross-document transition when entering Readest from Moke', () => {
    Object.defineProperty(window, 'navigation', {
      configurable: true,
      value: {
        activation: {
          from: { url: 'http://tauri.localhost/library' },
        },
      },
    });

    bootstrapMokeLaunchContext();

    expect(document.documentElement.dataset['mokeReaderTransition']).toBe('enter');
  });

  it('restores guest progress from local storage', () => {
    localStorage.setItem(
      mokeProgressStorageKey('', '42'),
      JSON.stringify({ location: 'epubcfi(/6/8)', updated_at: '2026-08-12T08:00:00.000Z' }),
    );

    bootstrapMokeLaunchContext();

    expect(window.__MOKE_RESTORE_PROGRESS).toMatchObject({ location: 'epubcfi(/6/8)' });
  });

  it('forwards the Moke debug panel launch flag', () => {
    window.history.replaceState({}, '', '/reader?moke=1&mokeDebug=1&mokeBookId=42');

    bootstrapMokeLaunchContext();

    expect(window.__MOKE_DEBUG_PANEL).toBe(true);
  });

  it('parses a direct Moke source without exposing it outside the bootstrap global', () => {
    const source = {
      kind: 'remote',
      identity: 'mokedeadbeefdeadbeef',
      cacheScope: '0123456789abcdef',
      cacheLimitBytes: 384 * 1024 * 1024,
      bookId: '42',
      format: 'epub',
      title: 'Sample',
      author: 'Author',
      serverUrl: 'https://books.test',
      url: 'https://books.test/api/book/42.epub?mode=read',
    };
    window.history.replaceState(
      {},
      '',
      `/reader?moke=1&mokeSource=${encodeURIComponent(JSON.stringify(source))}`,
    );

    bootstrapMokeLaunchContext();

    expect(window.__MOKE_BOOK_SOURCE).toEqual(source);
  });

  it('rejects malformed direct source payloads', () => {
    window.history.replaceState(
      {},
      '',
      `/reader?moke=1&mokeSource=${encodeURIComponent(JSON.stringify({ kind: 'remote' }))}`,
    );

    bootstrapMokeLaunchContext();

    expect(window.__MOKE_BOOK_SOURCE).toBeNull();
  });

  it('keeps the debug panel enabled when native navigation carries a stale zero flag', () => {
    localStorage.setItem(
      'moke-developer-storage',
      JSON.stringify({
        state: { unlocked: true, enabled: true, showDebugPanel: true },
        version: 0,
      }),
    );
    window.history.replaceState({}, '', '/reader?moke=1&mokeDebug=0&mokeBookId=42');

    bootstrapMokeLaunchContext();

    expect(window.__MOKE_DEBUG_PANEL).toBe(true);
  });

  it('keeps the panel hidden when both launch and persisted settings are disabled', () => {
    localStorage.setItem(
      'moke-developer-storage',
      JSON.stringify({ state: { showDebugPanel: false }, version: 0 }),
    );
    window.history.replaceState({}, '', '/reader?moke=1&mokeDebug=0&mokeBookId=42');

    bootstrapMokeLaunchContext();

    expect(window.__MOKE_DEBUG_PANEL).toBe(false);
  });

  it('reads the persisted switch defensively', () => {
    localStorage.setItem(
      'moke-developer-storage',
      JSON.stringify({ state: { showDebugPanel: true }, version: 0 }),
    );
    expect(readPersistedMokeDebugPanel()).toBe(true);

    localStorage.setItem('moke-developer-storage', '{broken');
    expect(readPersistedMokeDebugPanel()).toBe(false);
  });

  it('keeps an explicit annotation-locate target even when local progress is newer', () => {
    const serverUrl = 'http://192.168.1.5:8080';
    localStorage.setItem(
      mokeProgressStorageKey(serverUrl, '42'),
      JSON.stringify({ location: 'real-last-page', updated_at: '2026-08-12T10:00:00.000Z' }),
    );
    const annotationTarget = JSON.stringify({
      location: 'epubcfi(/6/4!/4/2)',
      updated_at: '2026-08-12T08:00:00.000Z',
      moke_navigation_id: 'locate-42',
      moke_navigation_kind: 'annotation-locate',
    });
    window.history.replaceState(
      {},
      '',
      `/reader?moke=1&mokeBookId=42&mokeServerUrl=${encodeURIComponent(serverUrl)}` +
        `&mokeRestoreProgress=${encodeURIComponent(annotationTarget)}`,
    );

    bootstrapMokeLaunchContext();

    expect(window.__MOKE_RESTORE_PROGRESS).toMatchObject({
      location: 'epubcfi(/6/4!/4/2)',
      moke_navigation_id: 'locate-42',
    });
  });

  it('prefers a newer local snapshot over stale server progress in the URL', () => {
    const serverUrl = 'http://192.168.1.5:8080';
    localStorage.setItem(
      mokeProgressStorageKey(serverUrl, '42'),
      JSON.stringify({ location: 'local-new', updated_at: '2026-08-12T09:00:00.000Z' }),
    );
    const remote = JSON.stringify({
      location: 'server-old',
      updated_at: '2026-08-12T08:00:00.000Z',
    });
    window.history.replaceState(
      {},
      '',
      `/reader?moke=1&mokeBookId=42&mokeServerUrl=${encodeURIComponent(serverUrl)}` +
        `&mokeRestoreProgress=${encodeURIComponent(remote)}`,
    );

    bootstrapMokeLaunchContext();

    expect(window.__MOKE_RESTORE_PROGRESS).toMatchObject({ location: 'local-new' });
  });
});
