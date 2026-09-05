/**
 * Moke 宿主集成桥接。
 *
 * 当阅读器嵌入 Moke 桌面客户端时（window.__MOKE_EMBEDDED === true），
 * 将阅读器事件上报给宿主，供拓展系统订阅。
 * 独立运行时（standalone）什么都不做。
 */

import type { Book } from '@/types/book';
import { mokeProgressStorageKey } from '@/helpers/mokeLaunchContext';

// ---------------------------------------------------------------------------
// Tauri invoke helper
// ---------------------------------------------------------------------------

let _invoke: (<T>(cmd: string, args: Record<string, unknown>) => Promise<T>) | null | undefined;

async function resolveInvoke() {
  if (_invoke !== undefined) return _invoke;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    _invoke = invoke;
  } catch (err) {
    // Don't cache failure permanently — transient import failures
    // (bundler race, dev HMR) should be retried next time.
    console.warn('[mokeBridge] @tauri-apps/api not available:', err);
    _invoke = null;
  }
  return _invoke;
}

function _doEmit(event: string, data: Record<string, unknown>): Promise<void> {
  return resolveInvoke().then((invoke) => {
    if (!invoke) return;
    return invoke('ext_reader_event', { event, data: withMokeContext(data) })
      .then(() => undefined)
      .catch((err) => {
        console.error('[mokeBridge] invoke ext_reader_event failed:', err);
      });
  });
}

// ---------------------------------------------------------------------------
// Throttle for high-frequency events (leading + trailing edge)
// ---------------------------------------------------------------------------

const THROTTLE_MS = 500;

interface ThrottleEntry {
  lastSent: number;
  timer: ReturnType<typeof setTimeout> | null;
  latest: Record<string, unknown>;
}

const _throttleEntries = new Map<string, ThrottleEntry>();

function throttledEmit(event: string, data: Record<string, unknown>) {
  const now = Date.now();
  let entry = _throttleEntries.get(event);

  if (!entry || now - entry.lastSent >= THROTTLE_MS) {
    // Leading edge: emit immediately.
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.lastSent = now;
    } else {
      entry = { lastSent: now, timer: null, latest: data };
      _throttleEntries.set(event, entry);
    }
    entry.latest = data;
    // Release the entry once the throttle window elapses with no further
    // events, so _throttleEntries never retains idle state.
    entry.timer = setTimeout(() => {
      _throttleEntries.delete(event);
    }, THROTTLE_MS);
    _doEmit(event, data);
    return;
  }

  // Within throttle window: store latest, schedule trailing emit.
  entry.latest = data;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(
    () => {
      _doEmit(event, entry.latest);
      entry.lastSent = Date.now();
      // Keep throttling for events that resume right after the trailing emit,
      // then release the entry once a full window passes without new events.
      entry.timer = setTimeout(() => {
        _throttleEntries.delete(event);
      }, THROTTLE_MS);
    },
    THROTTLE_MS - (now - entry.lastSent),
  );
}

/**
 * 仅测试用：当前节流表中存留的事件条目数。生产逻辑不依赖此值。
 */
export function throttleEntryCount(): number {
  return _throttleEntries.size;
}

// ---------------------------------------------------------------------------
// Embedded check
// ---------------------------------------------------------------------------

function isEmbedded(): boolean {
  return typeof window !== 'undefined' && !!window.__MOKE_EMBEDDED;
}

function withMokeContext(data: Record<string, unknown>): Record<string, unknown> {
  if (typeof window === 'undefined') return data;

  const mokeBookId = window.__MOKE_BOOK_ID;
  if (!mokeBookId || data['moke_book_id']) return data;

  return {
    ...data,
    moke_book_id: String(mokeBookId),
  };
}

// ---------------------------------------------------------------------------
// Annotation-locate navigation correlation
// ---------------------------------------------------------------------------

const ANNOTATION_NAVIGATION_TTL_MS = 2 * 60 * 1000;

type MokeNavigationPhase = 'pending' | 'navigating' | 'complete';

export interface MokeAnnotationNavigationContext {
  id: string;
  phase: MokeNavigationPhase;
  delivered: boolean;
}

interface MokeAnnotationNavigationState {
  id: string;
  phase: 'pending' | 'navigating' | 'settled';
  lastContext: MokeAnnotationNavigationContext | null;
  lastDelivery: Promise<void> | null;
  cleanupTimer: ReturnType<typeof setTimeout>;
}

let annotationNavigation: MokeAnnotationNavigationState | null = null;
let finishedAnnotationNavigationId: string | null = null;
let annotationDeliveryQueue = Promise.resolve();

function navigationIdFromRestoreProgress(): string | null {
  if (typeof window === 'undefined') return null;
  const progress = window.__MOKE_RESTORE_PROGRESS;
  if (!progress || typeof progress !== 'object') return null;
  const record = progress as Record<string, unknown>;
  return record['moke_navigation_kind'] === 'annotation-locate' &&
    typeof record['moke_navigation_id'] === 'string'
    ? record['moke_navigation_id']
    : null;
}

function getAnnotationNavigation(): MokeAnnotationNavigationState | null {
  const navigationId = navigationIdFromRestoreProgress();
  if (!navigationId || navigationId === finishedAnnotationNavigationId) return null;
  if (annotationNavigation?.id === navigationId) return annotationNavigation;
  if (annotationNavigation) finishAnnotationNavigation(annotationNavigation, false, false);

  const state: MokeAnnotationNavigationState = {
    id: navigationId,
    phase: 'pending',
    lastContext: null,
    lastDelivery: null,
    cleanupTimer: setTimeout(() => {
      if (annotationNavigation === state) finishAnnotationNavigation(state, false, true);
    }, ANNOTATION_NAVIGATION_TTL_MS),
  };
  annotationNavigation = state;
  return state;
}

function finishAnnotationNavigation(
  state: MokeAnnotationNavigationState,
  success: boolean,
  notifyHost: boolean,
): void {
  clearTimeout(state.cleanupTimer);
  if (annotationNavigation === state) annotationNavigation = null;
  finishedAnnotationNavigationId = state.id;
  if (notifyHost) {
    void _doEmit('annotation-locate:finished', {
      moke_navigation_id: state.id,
      success,
    });
  }
}

export function beginMokeAnnotationNavigation(): void {
  const state = getAnnotationNavigation();
  if (!state) return;
  state.phase = 'navigating';
  state.lastContext = null;
}

export function captureMokeAnnotationNavigation(): MokeAnnotationNavigationContext | null {
  const state = getAnnotationNavigation();
  if (!state) return null;
  const context: MokeAnnotationNavigationContext = {
    id: state.id,
    phase: state.phase === 'settled' ? 'complete' : state.phase,
    delivered: false,
  };
  state.lastContext = context;
  return context;
}

export function completeMokeAnnotationNavigation(): void {
  const state = getAnnotationNavigation();
  if (!state) return;
  state.phase = 'settled';
  const context = state.lastContext;
  if (context && !context.delivered) {
    // The raw relocate is waiting in FoliateViewer's rAF coalescer. Mutating
    // its captured context preserves correlation when it is emitted later.
    context.phase = 'complete';
  }
  finishAnnotationNavigationAfterDelivery(state);
}

export function cancelMokeAnnotationNavigation(notifyHost = true): void {
  const state = annotationNavigation ?? getAnnotationNavigation();
  if (state) finishAnnotationNavigation(state, false, notifyHost);
}

export function withMokeAnnotationNavigation(
  data: Record<string, unknown>,
  context: MokeAnnotationNavigationContext | null,
): Record<string, unknown> {
  if (!context) return data;
  const result = {
    ...data,
    moke_navigation_id: context.id,
    moke_navigation_kind: 'annotation-locate',
    moke_navigation_phase: context.phase,
  };
  context.delivered = true;
  return result;
}

function finishAnnotationNavigationAfterDelivery(state: MokeAnnotationNavigationState): void {
  if (state.phase !== 'settled' || !state.lastDelivery) return;
  const delivery = state.lastDelivery;
  void delivery.then(() => {
    if (
      annotationNavigation === state &&
      state.phase === 'settled' &&
      state.lastDelivery === delivery
    ) {
      // The finished receipt is emitted only after the last correlated page
      // event has reached the host, so it cannot clear suppression too early.
      finishAnnotationNavigation(state, true, true);
    }
  });
}

function isAnnotationNavigationEvent(data: Record<string, unknown>): boolean {
  return (
    data['moke_navigation_kind'] === 'annotation-locate' &&
    typeof data['moke_navigation_id'] === 'string'
  );
}

// ---------------------------------------------------------------------------
// Moke 服务器进度直存（单 WebView 运行时专用）
// ---------------------------------------------------------------------------
//
// 在 Android / iOS / OHOS 上，宿主 Moke 应用只有唯一一个 WebView。打开阅读器时
// Moke 会整页导航到 `/readest/reader`，把 Moke 应用（含 ReaderProgressProvider）
// 卸载掉——桌面端由主窗口消费的 `reader:page:changed` 事件在移动端没有监听者。
// 因此宿主会把 serverUrl 通过 `mokeServerUrl` 查询参数透传进来，由阅读器在嵌入
// 模式下直接把进度保存到 Moke 服务器（与桌面端 ReaderProgressProvider 的保存
// 逻辑保持一致，POST 到 `/api/book/{id}/progress`）。
//
// 桌面端阅读器窗口拿不到 `mokeServerUrl`（宿主不传），所以这里不会与桌面端
// 主窗口的 ReaderProgressProvider 重复保存。

const PROGRESS_SAVE_DEBOUNCE_MS = 1200;
const SAFE_ERROR_CODE = /^[a-z0-9._-]{1,64}$/i;

export interface MokeReaderErrorDetail {
  code: string;
  operation: 'progress.save';
  status?: number;
  retryable: boolean;
}

class MokeProgressSaveError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(code);
    this.name = 'MokeProgressSaveError';
  }
}

function reportMokeReaderError(error: unknown): void {
  const status = error instanceof MokeProgressSaveError ? error.status : undefined;
  const code =
    error instanceof MokeProgressSaveError && SAFE_ERROR_CODE.test(error.code)
      ? error.code
      : 'progress.network';
  const detail: MokeReaderErrorDetail = {
    code,
    operation: 'progress.save',
    ...(status === undefined ? {} : { status }),
    retryable: status === undefined || status === 408 || status === 429 || status >= 500,
  };

  // Deliberately log only normalized metadata: transport errors may contain a
  // URL, cookie or credential supplied by the embedding host.
  console.warn('[mokeBridge] Reader integration error:', detail);
  window.dispatchEvent(new CustomEvent<MokeReaderErrorDetail>('moke:reader-error', { detail }));
  void _doEmit('reader:error', detail as unknown as Record<string, unknown>);
}

async function validateProgressResponse(response: Response): Promise<void> {
  if (!response.ok) {
    throw new MokeProgressSaveError(`progress.http.${response.status}`, response.status);
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() || '';
  if (!contentType.includes('application/json')) {
    throw new MokeProgressSaveError('progress.invalid_response', response.status);
  }

  let envelope: { err?: unknown };
  try {
    envelope = (await response.json()) as { err?: unknown };
  } catch {
    throw new MokeProgressSaveError('progress.invalid_response', response.status);
  }
  if (typeof envelope.err === 'string' && envelope.err !== '' && envelope.err !== 'ok') {
    const serverCode = SAFE_ERROR_CODE.test(envelope.err) ? envelope.err : 'invalid';
    throw new MokeProgressSaveError(`progress.api.${serverCode}`, response.status);
  }
}

let progressSaveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingProgress: Record<string, unknown> | null = null;
let progressFlushListenersRegistered = false;

function progressStringValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function progressNumberValue(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

async function saveProgressToMokeServer(data: Record<string, unknown>): Promise<void> {
  const serverUrl = window.__MOKE_SERVER_URL;
  const mokeBookId = window.__MOKE_BOOK_ID;
  if (typeof serverUrl !== 'string' || !serverUrl || !mokeBookId) return;

  const payload = {
    schema: 'moke.readest.progress.v1',
    reader: 'readest',
    moke_book_id: String(mokeBookId),
    reader_book_id: progressStringValue(data['book_id']),
    view_key: progressStringValue(data['view_key']),
    location: progressStringValue(data['location']),
    section_href: progressStringValue(data['section_href']),
    chapter: progressStringValue(data['chapter']),
    page: progressNumberValue(data['page']),
    total_pages: progressNumberValue(data['total_pages']),
    progress: progressNumberValue(data['progress']),
    fraction: progressNumberValue(data['fraction']),
    updated_at: new Date().toISOString(),
  };

  try {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
    const response = await tauriFetch(
      `${serverUrl}/api/book/${encodeURIComponent(String(mokeBookId))}/progress`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ progress: payload }),
        credentials: 'include',
        maxRedirections: 5,
        danger: { acceptInvalidCerts: true, acceptInvalidHostnames: true },
      } as unknown as RequestInit,
    );
    await validateProgressResponse(response);
  } catch (error) {
    // Best effort: rendering continues, while both Moke IPC and the browser
    // error event expose a stable, non-secret failure for diagnostics/E2E.
    reportMokeReaderError(error);
  }
}

let onlineReadMarked = false;

export async function markMokeOnlineRead(): Promise<void> {
  if (onlineReadMarked || typeof window === 'undefined') return;
  const source = window.__MOKE_BOOK_SOURCE;
  const serverUrl = window.__MOKE_SERVER_URL;
  const mokeBookId = window.__MOKE_BOOK_ID;
  if (source?.kind !== 'remote' || !serverUrl || !mokeBookId) return;
  onlineReadMarked = true;
  try {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
    const response = await tauriFetch(
      `${serverUrl}/api/book/${encodeURIComponent(String(mokeBookId))}/readstate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ read_state: 1, online_read: 1 }),
        credentials: 'include',
        maxRedirections: 5,
        danger: { acceptInvalidCerts: true, acceptInvalidHostnames: true },
      } as unknown as RequestInit,
    );
    if (!response.ok) throw new Error(`moke.online_read.http.${response.status}`);
  } catch (error) {
    onlineReadMarked = false;
    reportMokeReaderError(error);
  }
}

function saveProgressToLocalStorage(data: Record<string, unknown>): void {
  const mokeBookId = window.__MOKE_BOOK_ID;
  if (!mokeBookId) return;
  const serverUrl = typeof window.__MOKE_SERVER_URL === 'string' ? window.__MOKE_SERVER_URL : '';
  const payload = {
    schema: 'moke.readest.progress.v1',
    reader: 'readest',
    moke_book_id: String(mokeBookId),
    reader_book_id: progressStringValue(data['book_id']),
    view_key: progressStringValue(data['view_key']),
    location: progressStringValue(data['location']),
    section_href: progressStringValue(data['section_href']),
    chapter: progressStringValue(data['chapter']),
    page: progressNumberValue(data['page']),
    total_pages: progressNumberValue(data['total_pages']),
    progress: progressNumberValue(data['progress']),
    fraction: progressNumberValue(data['fraction']),
    updated_at: new Date().toISOString(),
  };

  try {
    window.localStorage.setItem(
      mokeProgressStorageKey(serverUrl, String(mokeBookId)),
      JSON.stringify(payload),
    );
  } catch {
    // Local storage is best-effort (some ArkWeb custom-scheme contexts deny it).
  }
}

function scheduleProgressSave(data: Record<string, unknown>): void {
  ensureProgressFlushListeners();
  pendingProgress = data;
  if (progressSaveTimer) clearTimeout(progressSaveTimer);
  progressSaveTimer = setTimeout(() => {
    progressSaveTimer = null;
    const latest = pendingProgress;
    pendingProgress = null;
    if (latest) void saveProgressToMokeServer(latest);
  }, PROGRESS_SAVE_DEBOUNCE_MS);
}

function flushProgressSave(): Promise<void> {
  if (progressSaveTimer) {
    clearTimeout(progressSaveTimer);
    progressSaveTimer = null;
  }
  const latest = pendingProgress;
  pendingProgress = null;
  if (!latest) return Promise.resolve();
  return saveProgressToMokeServer(latest);
}

function ensureProgressFlushListeners(): void {
  if (typeof window === 'undefined' || progressFlushListenersRegistered) return;
  progressFlushListenersRegistered = true;

  // System back gestures, app backgrounding, and OS process reclamation can
  // unload the single mobile WebView without emitting book:closed. Start the
  // pending direct save as soon as the page is hidden instead of waiting for
  // the debounce timer that will be destroyed with the page.
  window.addEventListener('pagehide', () => {
    void flushProgressSave();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushProgressSave();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Events that should be throttled to avoid flooding extension backends. */
const THROTTLED_EVENTS = new Set(['page:changed']);

/**
 * 向 Moke 宿主上报阅读器事件。高频事件（如 page:changed）自动节流。
 *
 * 返回一个 Promise，resolve() 时表示事件已送达（或尽力送达）。
 * 调用方（尤其是关闭流程）应 await 此返回值，确保事件在窗口销毁前发出。
 */
export function emitReaderEvent(event: string, data: Record<string, unknown>): Promise<void> {
  if (!isEmbedded()) return Promise.resolve();

  const annotationNavigationEvent = event === 'page:changed' && isAnnotationNavigationEvent(data);

  // Correlated startup/annotation relocations are previews, not reading
  // progress. Skip both local and server persistence; genuine user turns have
  // no navigation marker and continue through the ordinary paths below.
  if (event === 'page:changed' && !annotationNavigationEvent) {
    saveProgressToLocalStorage(data);
  }

  // 单 WebView 运行时宿主应用已被卸载，这里由阅读器直接保存进度。
  if (
    event === 'page:changed' &&
    !annotationNavigationEvent &&
    typeof window.__MOKE_SERVER_URL === 'string'
  ) {
    scheduleProgressSave(data);
  }

  // 关闭书籍前先冲刷待保存的进度并回收定位状态。
  if (event === 'book:closed') {
    cancelMokeAnnotationNavigation();
    return flushProgressSave().then(() => _doEmit(event, data));
  }

  // Never put correlation markers behind the generic trailing-edge throttle:
  // a completion receipt could otherwise clear the host state before the
  // delayed page event arrives. These launch-only events are low volume.
  if (annotationNavigationEvent) {
    const delivery = annotationDeliveryQueue.then(() => _doEmit(event, data));
    annotationDeliveryQueue = delivery;
    const navigationId = data['moke_navigation_id'];
    const state = annotationNavigation;
    if (state && state.id === navigationId) {
      state.lastDelivery = delivery;
      finishAnnotationNavigationAfterDelivery(state);
    }
    return delivery;
  }

  if (THROTTLED_EVENTS.has(event)) {
    throttledEmit(event, data);
    return Promise.resolve();
  }

  return _doEmit(event, data);
}

/**
 * 从 readest 的 Book 对象提取事件数据。
 */
export function bookEventData(book: Book): Record<string, unknown> {
  return {
    book_id: book.hash,
    title: book.title ?? '',
    author: book.author ?? '',
    format: book.format ?? '',
    cover_url: book.coverImageUrl ?? '',
    language: book.primaryLanguage ?? '',
  };
}
