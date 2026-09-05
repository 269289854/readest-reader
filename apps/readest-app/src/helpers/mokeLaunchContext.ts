import { parseMokeBookSource } from '@/helpers/mokeBookSource';

const MOKE_PROGRESS_STORAGE_PREFIX = 'moke:reading-progress:';
const MOKE_DEVELOPER_STORAGE_KEY = 'moke-developer-storage';

export function readPersistedMokeDebugPanel(
  storage: Pick<Storage, 'getItem'> = window.localStorage,
): boolean {
  try {
    const value: unknown = JSON.parse(storage.getItem(MOKE_DEVELOPER_STORAGE_KEY) || '{}');
    const state = value && typeof value === 'object' ? (value as { state?: unknown }).state : null;
    return !!(
      state &&
      typeof state === 'object' &&
      (state as { showDebugPanel?: unknown }).showDebugPanel === true
    );
  } catch {
    return false;
  }
}

export function mokeProgressStorageKey(serverUrl: string, mokeBookId: string): string {
  return `${MOKE_PROGRESS_STORAGE_PREFIX}${encodeURIComponent(serverUrl)}:${encodeURIComponent(mokeBookId)}`;
}

/** Bootstrap the Moke reader globals before React starts. */
export function bootstrapMokeLaunchContext(): void {
  const params = new URLSearchParams(window.location.search);
  if (params.get('moke') !== '1') return;

  // Cross-document View Transitions are attached to the navigation itself,
  // not to a particular button. Mark every Moke -> Readest document entry so
  // the same animation covers the host's read button and embedded-reader
  // button. The marker is cleared after the transition so normal Readest SPA
  // transitions keep their existing animation direction.
  const navigationApi = (
    window as Window & {
      navigation?: { activation?: { from?: { url?: string } | null } };
    }
  ).navigation;
  const fromUrl = navigationApi?.activation?.from?.url;
  if (fromUrl) {
    try {
      const fromPath = new URL(fromUrl).pathname.replace(/\/$/, '') || '/';
      if (fromPath !== '/readest' && !fromPath.startsWith('/readest/')) {
        const root = document.documentElement;
        root.dataset['mokeReaderTransition'] = 'enter';
        const clearMarker = () => {
          delete root.dataset['mokeReaderTransition'];
        };
        window.addEventListener(
          'pagereveal',
          (event) => {
            const transition = (
              event as Event & {
                viewTransition?: { finished: Promise<unknown> };
              }
            ).viewTransition;
            if (!transition) {
              clearMarker();
              return;
            }
            void transition.finished.finally(clearMarker).catch(() => undefined);
          },
          { once: true },
        );
        window.setTimeout(clearMarker, 1_000);
      }
    } catch {
      // Ignore malformed activation URLs and continue bootstrapping Moke.
    }
  }

  const serverUrl = params.get('mokeServerUrl') || '';
  const mokeBookId = params.get('mokeBookId') || '';
  window.__MOKE_EMBEDDED = true;
  window.__MOKE_EINK = params.get('mokeEink') === '1';
  // Moke and the embedded reader share the same WebView storage on mobile.
  // The native full-document navigation can race Zustand hydration and carry
  // a stale mokeDebug=0 even though the persisted switch is already enabled.
  // This function is serialized into an inline bootstrap script, so keep the
  // storage read self-contained instead of calling the exported helper above.
  let persistedDebugPanel = false;
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem('moke-developer-storage') || '{}',
    );
    const state = value && typeof value === 'object' ? (value as { state?: unknown }).state : null;
    persistedDebugPanel = !!(
      state &&
      typeof state === 'object' &&
      (state as { showDebugPanel?: unknown }).showDebugPanel === true
    );
  } catch {
    persistedDebugPanel = false;
  }
  window.__MOKE_DEBUG_PANEL = params.get('mokeDebug') === '1' || persistedDebugPanel;
  window.__MOKE_BOOK_ID = mokeBookId || null;
  window.__MOKE_SERVER_URL = serverUrl || null;
  window.__MOKE_BOOK_SOURCE = null;
  const source = params.get('mokeSource');
  if (source) {
    try {
      window.__MOKE_BOOK_SOURCE = parseMokeBookSource(JSON.parse(source));
    } catch {
      window.__MOKE_BOOK_SOURCE = null;
    }
  }
  let remoteProgress: Record<string, unknown> | null = null;
  const progress = params.get('mokeRestoreProgress');
  if (progress) {
    try {
      const parsed: unknown = JSON.parse(progress);
      if (parsed && typeof parsed === 'object') {
        remoteProgress = parsed as Record<string, unknown>;
      }
    } catch {
      remoteProgress = null;
    }
  }

  let localProgress: Record<string, unknown> | null = null;
  if (mokeBookId) {
    try {
      const prefix = 'moke:reading-progress:';
      const key = `${prefix}${encodeURIComponent(serverUrl)}:${encodeURIComponent(mokeBookId)}`;
      const stored = window.localStorage.getItem(key);
      const parsed: unknown = stored ? JSON.parse(stored) : null;
      if (parsed && typeof parsed === 'object') {
        localProgress = parsed as Record<string, unknown>;
      }
    } catch {
      localProgress = null;
    }
  }

  // Annotation location is an explicit one-shot navigation, not a candidate
  // for "newest reading progress" selection. Keep it even when the user's
  // ordinary local snapshot is newer; the bridge suppresses only its correlated
  // relocations so that snapshot remains untouched.
  if (
    remoteProgress?.['moke_navigation_kind'] === 'annotation-locate' &&
    typeof remoteProgress['moke_navigation_id'] === 'string'
  ) {
    window.__MOKE_RESTORE_PROGRESS = remoteProgress;
    return;
  }

  if (!localProgress) {
    window.__MOKE_RESTORE_PROGRESS = remoteProgress;
    return;
  }
  if (!remoteProgress) {
    window.__MOKE_RESTORE_PROGRESS = localProgress;
    return;
  }

  const localTime = Date.parse(String(localProgress['updated_at'] || ''));
  const remoteTime = Date.parse(String(remoteProgress['updated_at'] || ''));
  window.__MOKE_RESTORE_PROGRESS =
    Number.isFinite(localTime) && (!Number.isFinite(remoteTime) || localTime >= remoteTime)
      ? localProgress
      : remoteProgress;
}
