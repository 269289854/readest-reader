'use client';

import React, { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';

import { Book } from '@/types/book';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useReaderStore } from '@/store/readerStore';
import { useSidebarStore } from '@/store/sidebarStore';
import { useAndroidGamepadConnection } from '@/hooks/useAndroidGamepadConnection';
import { useGamepad } from '@/hooks/useGamepad';
import { useTranslation } from '@/hooks/useTranslation';
import { SystemSettings } from '@/types/settings';
import { parseOpenWithFiles } from '@/helpers/openWith';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { UnlistenFn } from '@tauri-apps/api/event';
import { tauriHandleClose, tauriHandleOnCloseWindow } from '@/utils/window';
import { isTauriAppPlatform } from '@/services/environment';
import { invoke } from '@tauri-apps/api/core';
import { splitLibraryOpenIds } from '@/utils/audiobook';
import { uniqueId } from '@/utils/misc';
import { partialMD5 } from '@/utils/md5';
import { eventDispatcher } from '@/utils/event';
import {
  closeReaderWindowOrGoToLibrary,
  ensureMainLibraryWindow,
  navigateToLibrary,
} from '@/utils/nav';
import { clearDiscordPresence } from '@/utils/discord';
import { BOOK_IDS_SEPARATOR } from '@/services/constants';
import { emitReaderEvent } from '@/services/mokeBridge';
import { useAuth } from '@/context/AuthContext';
import { resolveReaderReturnTarget } from '@/utils/readerBack';

import useBooksManager from '../hooks/useBooksManager';
import useBookShortcuts from '../hooks/useBookShortcuts';
import { useMokeCommandListener } from '../hooks/useMokeCommandListener';
import Spinner from '@/components/Spinner';
import SideBar from './sidebar/SideBar';
import LazyNotebook from './notebook/LazyNotebook';
import LocalSendManager from '@/components/localsend/LocalSendManager';
import BooksGrid from './BooksGrid';
import { runTransientReaderBootstrap } from '../utils/transientReader';
import { makeMokeSourceBook } from '@/helpers/mokeBookSource';

// These dialogs pull in metadata, sync-provider, and AI integrations that are
// not needed to paint or open a book. Keep them out of the cold-start path and
// load each one only after the corresponding user action.
const SettingsDialog = dynamic(() => import('@/components/settings/SettingsDialog'));
const AudiobookPairingDialog = dynamic(() => import('./audiobook/AudiobookPairingDialog'));
const HardcoverLinkDialog = dynamic(() => import('./hardcover/HardcoverLinkDialog'));
const BookDetailModal = dynamic(() =>
  import('@/components/metadata').then((module) => module.BookDetailModal),
);
const ShareBookDialog = dynamic(() => import('@/app/library/components/ShareBookDialog'));

// Moke mobile has a single WebView, so it navigates that WebView to the
// bundled reader with the downloaded book path in the query string. Desktop
// reader windows receive the same path through OPEN_WITH_FILES instead.
const getMokeEmbeddedFiles = () => {
  if (typeof window === 'undefined' || !window.__MOKE_EMBEDDED) return [];
  return new URLSearchParams(window.location.search).getAll('file').filter(Boolean);
};

const getMokeBookSource = () =>
  typeof window !== 'undefined' && window.__MOKE_EMBEDDED
    ? (window.__MOKE_BOOK_SOURCE ?? null)
    : null;

const ReaderContent: React.FC<{ ids?: string; settings: SystemSettings }> = ({ ids, settings }) => {
  const _ = useTranslation();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { envConfig, appService } = useEnv();
  const { bookKeys, dismissBook, getNextBookKey } = useBooksManager();
  const { sideBarBookKey, setSideBarBookKey } = useSidebarStore();
  const { saveSettings } = useSettingsStore();
  const { getConfig, getBookData, saveConfig } = useBookDataStore();
  const { getView, setBookKeys, getViewSettings } = useReaderStore();
  const { initViewState, getViewState, clearViewState } = useReaderStore();
  const { isSettingsDialogOpen, settingsDialogBookKey } = useSettingsStore();
  const [showDetailsBook, setShowDetailsBook] = useState<Book | null>(null);
  const [audiobookBookKey, setAudiobookBookKey] = useState<string | null>(null);
  const [hardcoverLinkBookKey, setHardcoverLinkBookKey] = useState<string | null>(null);
  const [shareDialogState, setShareDialogState] = useState<{
    book: Book;
    cfi: string | null;
  } | null>(null);
  const { user } = useAuth();
  const isInitiating = useRef(false);
  const hasHandledOpenFiles = useRef(false);
  const closingBooksRef = useRef<{ bookKeys: string; promise: Promise<void> } | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorLoading, setErrorLoading] = useState(false);

  useBookShortcuts({ sideBarBookKey, bookKeys });
  useMokeCommandListener(bookKeys);
  const isAndroidApp = appService?.isAndroidApp === true;
  const androidGamepadConnected = useAndroidGamepadConnection(isAndroidApp);
  // Android's native bridge gates the Web Gamepad API so Chromium polls only
  // while a controller exists. Other platforms retain the existing behavior.
  useGamepad({
    enabled: appService !== null && (!isAndroidApp || androidGamepadConnected),
  });

  useEffect(() => {
    if (isInitiating.current) return;
    isInitiating.current = true;

    const pathname = window.location.pathname;
    const bookIds = ids || searchParams?.get('ids') || pathname.split('/reader/')[1] || '';
    const requestedIds = bookIds.split(BOOK_IDS_SEPARATOR).filter(Boolean);
    const mokeFiles = getMokeEmbeddedFiles();

    // No ids provided — check if the window was opened with a file path,
    // either from the desktop window bootstrap or Moke mobile's URL.
    // Dispatching is deferred to a separate effect that waits for appService.
    if (
      requestedIds.length === 0 &&
      (getMokeBookSource() || window.OPEN_WITH_FILES?.length || mokeFiles.length)
    ) {
      return;
    }

    // A streaming audiobook has no document to load - a deep link naming one
    // (a stale bookmark, an "Open With" link, etc.) must not reach
    // initViewState/loadBookContent. A lone audiobook id redirects to the
    // player; one mixed into a multi-book deep link is just dropped, and the
    // rest of the reader opens normally. Same split the library's own open
    // paths use (src/utils/audiobook.ts), so a stray ABS id is handled
    // identically everywhere it could turn up.
    const { getBookByHash } = useLibraryStore.getState();
    const { audiobookHash, readerIds: initialIds } = splitLibraryOpenIds(
      requestedIds,
      getBookByHash,
    );
    if (audiobookHash) {
      router.replace(`/player?id=${audiobookHash}`);
      return;
    }
    const initialBookKeys = initialIds.map((id) => `${id}-${uniqueId()}`);
    setBookKeys(initialBookKeys);
    const uniqueIds = new Set<string>();
    console.log('Initialize books', initialBookKeys);
    initialBookKeys.forEach((key, index) => {
      const id = key.split('-')[0]!;
      const isPrimary = !uniqueIds.has(id);
      uniqueIds.add(id);
      if (!getViewState(key)) {
        initViewState(envConfig, id, key, isPrimary).catch((error) => {
          console.log('Error initializing book', key, error);
          setErrorLoading(true);
          eventDispatcher.dispatch('toast', {
            message: _('Unable to open book'),
            callback: async () => {
              const service = await envConfig.getAppService();
              await closeReaderWindowOrGoToLibrary(service, router);
            },
            timeout: 2000,
            type: 'error',
          });
        });
        if (index === 0) setSideBarBookKey(key);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the reader window is opened with a file path via open_reader_window
  // (Rust sets window.OPEN_WITH_FILES before React boots), or Moke mobile puts
  // the path in the URL, load the file as a transient book directly in THIS
  // window.
  //
  // We can't reuse the usual app-incoming-url → useOpenWithBooks path: that
  // hook early-returns for any /reader pathname (it assumes a reader is already
  // active), and even its openTransient branch finishes with navigateToReader,
  // which is a no-op here — App Router won't remount ReaderContent on a same
  // /reader push, and the init effect above has empty deps. So we import the
  // file transiently (no library write) and seed bookKeys/initViewState
  // ourselves, mirroring both openTransient and the init effect.
  useEffect(() => {
    if (!appService) return;
    if (hasHandledOpenFiles.current) return;

    const mokeSource = getMokeBookSource();
    const mokeFiles = getMokeEmbeddedFiles();
    const files = window.OPEN_WITH_FILES?.length ? window.OPEN_WITH_FILES : mokeFiles;
    if (!mokeSource && !files?.length) return;

    hasHandledOpenFiles.current = true;
    window.OPEN_WITH_FILES = null;

    const failToOpen = () => {
      setErrorLoading(true);
      eventDispatcher.dispatch('toast', {
        message: _('Unable to open book'),
        callback: async () => {
          const service = await envConfig.getAppService();
          await closeReaderWindowOrGoToLibrary(service, router);
        },
        timeout: 2000,
        type: 'error',
      });
    };

    const openTransientFiles = async () => {
      // Files selected through Readest's own picker receive this grant in
      // nativeAppService.selectFiles(). Moke hands its AppData file to the
      // embedded reader through the URL instead, so iOS has not seen the path
      // before the first NativeFile.open(). Explicitly grant that exact file
      // before importing it; this is a no-op on Android and harmless on
      // desktop, where the static AppData scope already covers the file.
      if (mokeSource?.kind === 'local') {
        await appService.allowPathsInScopes?.([mokeSource.filePath], false);
      } else if (!mokeSource) {
        await appService.allowPathsInScopes?.(files, false);
      }

      // Load the real library from disk before building any transient entry, so
      // initViewState's getBookByHash can resolve the book and an empty-store
      // save can't wipe library.json (same rationale as useOpenWithBooks).
      const { setLibrary, getBookByHash, libraryLoaded } = useLibraryStore.getState();
      let library = useLibraryStore.getState().library;
      if (!libraryLoaded) {
        library = await appService.loadLibraryBooks();
        setLibrary(library);
      }

      const bookIds: string[] = [];
      let libraryMutated = false;
      if (mokeSource) {
        const directBook = makeMokeSourceBook(mokeSource);
        const existing = getBookByHash(directBook.hash);
        if (existing) {
          Object.assign(existing, directBook);
        } else {
          library.push(directBook);
        }
        bookIds.push(directBook.hash);
        libraryMutated = true;
      }

      if (!mokeSource) {
        for (const file of files) {
          try {
            // Hash-precheck: if the file is already a managed (non-deleted)
            // library book, route to it without importBook — transient import
            // would otherwise rewrite that entry's filePath/createdAt.
            let existingHash: string | undefined;
            try {
              const fileobj = await appService.openFile(file, 'None');
              try {
                existingHash = await partialMD5(fileobj);
              } finally {
                const closable = fileobj as File & { close?: () => Promise<void> };
                if (closable.close) await closable.close();
              }
            } catch (e) {
              console.warn('Pre-hash failed, falling back to transient import:', file, e);
            }

            if (existingHash) {
              const existing = getBookByHash(existingHash);
              if (existing && !existing.deletedAt) {
                bookIds.push(existing.hash);
                continue;
              }
            }

            const book = await appService.importBook(file, library, { transient: true });
            if (book) {
              bookIds.push(book.hash);
              libraryMutated = true;
            }
          } catch (e) {
            console.warn('Failed to open file in reader window:', file, e);
          }
        }
      }

      if (bookIds.length === 0) {
        failToOpen();
        return;
      }
      if (libraryMutated) setLibrary(library);

      const newBookKeys = bookIds
        .filter((id) => !!getBookByHash(id))
        .map((id) => `${id}-${uniqueId()}`);
      if (newBookKeys.length === 0) {
        failToOpen();
        return;
      }
      setBookKeys(newBookKeys);
      const uniqueIds = new Set<string>();
      newBookKeys.forEach((key, index) => {
        const id = key.split('-')[0]!;
        const isPrimary = !uniqueIds.has(id);
        uniqueIds.add(id);
        if (!getViewState(key)) {
          initViewState(envConfig, id, key, isPrimary).catch((error) => {
            console.log('Error initializing book', key, error);
            failToOpen();
          });
          if (index === 0) setSideBarBookKey(key);
        }
      });
    };

    // Failures before the per-file import loop (for example loading the
    // library database) must leave the loading state instead of spinning
    // forever. Keep this wrapper independently tested because these failures
    // happen before initViewState's own rejection handler exists.
    void runTransientReaderBootstrap(openTransientFiles, failToOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appService]);

  useEffect(() => {
    const handleManageAudiobook = (event: CustomEvent) => {
      const detail = event.detail as { bookKey?: string } | undefined;
      if (detail?.bookKey) setAudiobookBookKey(detail.bookKey);
    };
    const handleLinkHardcoverBook = (event: CustomEvent) => {
      const detail = event.detail as { bookKey?: string } | undefined;
      if (detail?.bookKey) setHardcoverLinkBookKey(detail.bookKey);
    };
    eventDispatcher.on('manage-audiobook', handleManageAudiobook);
    eventDispatcher.on('hardcover-link-book', handleLinkHardcoverBook);
    return () => {
      eventDispatcher.off('manage-audiobook', handleManageAudiobook);
      eventDispatcher.off('hardcover-link-book', handleLinkHardcoverBook);
    };
  }, []);

  useEffect(() => {
    const handleShowBookDetails = (event: CustomEvent) => {
      setShowDetailsBook(event.detail as Book);
      return true;
    };
    eventDispatcher.onSync('show-book-details', handleShowBookDetails);

    return () => {
      eventDispatcher.offSync('show-book-details', handleShowBookDetails);
    };
  }, []);

  useEffect(() => {
    const handleShareIntent = (event: CustomEvent) => {
      const detail = event.detail as { book: Book; cfi?: string | null } | undefined;
      if (!detail?.book) return;
      if (!user) {
        eventDispatcher.dispatch('toast', {
          type: 'info',
          message: _('Sign in to share books'),
          timeout: 2500,
        });
        return;
      }
      setShareDialogState({
        book: detail.book,
        cfi: detail.cfi ?? null,
      });
    };
    eventDispatcher.on('show-share-dialog', handleShareIntent);
    return () => {
      eventDispatcher.off('show-share-dialog', handleShareIntent);
    };
  }, [user, _]);

  useEffect(() => {
    if (bookKeys && bookKeys.length > 0) {
      const settings = useSettingsStore.getState().settings;
      const lastOpenBooks = bookKeys.map((key) => key.split('-')[0]!);
      if (settings.lastOpenBooks?.toString() !== lastOpenBooks.toString()) {
        settings.lastOpenBooks = lastOpenBooks;
        saveSettings(envConfig, settings);
      }
    }

    let unlistenOnCloseWindow: Promise<UnlistenFn>;
    if (appService?.hasWindow) {
      unlistenOnCloseWindow = tauriHandleOnCloseWindow(handleCloseBooks).catch((error) => {
        console.info('Failed to register close-window listener:', error);
        return () => {};
      });
    }
    window.addEventListener('beforeunload', handleCloseBooks);
    eventDispatcher.on('beforereload', handleCloseBooks);
    eventDispatcher.on('close-reader', handleCloseReaderToLibrary);
    eventDispatcher.on('quit-app', handleCloseBooks);
    return () => {
      window.removeEventListener('beforeunload', handleCloseBooks);
      eventDispatcher.off('beforereload', handleCloseBooks);
      eventDispatcher.off('close-reader', handleCloseReaderToLibrary);
      eventDispatcher.off('quit-app', handleCloseBooks);
      unlistenOnCloseWindow?.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKeys, appService?.hasWindow]);

  const saveBookConfig = async (bookKey: string) => {
    const config = getConfig(bookKey);
    const { book } = getBookData(bookKey) || {};
    const { isPrimary } = getViewState(bookKey) || {};
    if (isPrimary && book && config) {
      const settings = useSettingsStore.getState().settings;
      eventDispatcher.dispatch('sync-book-progress', { bookKey });
      eventDispatcher.dispatch('flush-kosync', { bookKey });
      await saveConfig(envConfig, bookKey, config, settings);
    }
  };

  const saveConfigAndCloseBook = async (bookKey: string, keepTTSAlive = false) => {
    console.log('Closing book', bookKey);

    const viewState = getViewState(bookKey);
    if (viewState?.isPrimary && appService?.isDesktopApp) {
      await clearDiscordPresence(appService);
    }

    try {
      getView(bookKey)?.close();
      getView(bookKey)?.remove();
    } catch {
      console.info('Error closing book', bookKey);
    }
    // Closes that keep the webview alive (back to library, Android back, pane
    // dismiss) let a live TTS session continue in the background;
    // webview-destroying closes (quit, window close, reload) hard-stop so the
    // media session and Android foreground service tear down with the page.
    eventDispatcher.dispatch(keepTTSAlive ? 'tts-close-book' : 'tts-stop', {
      bookKey,
    });
    await saveBookConfig(bookKey);

    // Notify host (Moke): book closed. Must be awaited so the event
    // reaches the Rust backend before the window is destroyed.
    if (viewState?.isPrimary) {
      await emitReaderEvent('book:closed', {
        book_id: bookKey.split('-')[0],
        view_key: bookKey,
      });
    }

    clearViewState(bookKey);
  };

  const navigateBackToLibrary = async () => {
    const returnTarget = resolveReaderReturnTarget(window.location.search);
    if (returnTarget.kind === 'moke') {
      try {
        await invoke('moke_navigate', { path: returnTarget.path });
      } catch (error) {
        console.warn('moke_navigate failed, falling back to full-document navigation:', error);
        window.location.assign(returnTarget.path);
      }
      return;
    }
    navigateToLibrary(router, '', undefined, true);
  };

  const saveSettingsAndGoToLibrary = () => {
    saveSettings(envConfig, settings);
    void navigateBackToLibrary();
  };

  const handleCloseReaderToLibrary = () => {
    return handleCloseBooks(true);
  };

  // Also wired directly to beforeunload/quit-app/window-close, which pass an
  // event object: only a literal `true` keeps TTS alive.
  const handleCloseBooks = (keepTTSAlive?: unknown): Promise<void> => {
    const key = bookKeys.join(BOOK_IDS_SEPARATOR);
    const activeClose = closingBooksRef.current;
    if (activeClose?.bookKeys === key) return activeClose.promise;

    const promise = (async () => {
      const settings = useSettingsStore.getState().settings;
      await Promise.all(
        bookKeys.map(async (bookKey) => saveConfigAndCloseBook(bookKey, keepTTSAlive === true)),
      );
      await saveSettings(envConfig, settings);
    })();
    closingBooksRef.current = { bookKeys: key, promise };
    return promise;
  };

  const handleCloseBooksToLibrary = async () => {
    // SPA navigation in the main window (or on web) keeps the webview alive:
    // TTS may continue headless. Non-main Tauri windows close their webview
    // below, but their per-window TTS dies with the window either way.
    await handleCloseBooks(true);
    if (isTauriAppPlatform()) {
      const currentWindow = getCurrentWindow();
      if (currentWindow.label === 'main') {
        await navigateBackToLibrary();
      } else {
        if (appService) {
          await ensureMainLibraryWindow(appService);
        }
        currentWindow.close();
      }
    } else {
      await navigateBackToLibrary();
    }
  };

  const handleCloseBook = async (bookKey: string) => {
    // Header X / pane close: an SPA-side close on web and the main window.
    // The Tauri reader-window branches below destroy their webview, which
    // takes the per-window TTS with it either way.
    saveConfigAndCloseBook(bookKey, true);
    if (sideBarBookKey === bookKey) {
      setSideBarBookKey(getNextBookKey(sideBarBookKey));
    }
    dismissBook(bookKey);
    if (bookKeys.filter((key) => key !== bookKey).length == 0) {
      const openWithFiles = (await parseOpenWithFiles(appService)) || [];
      if (appService?.hasWindow) {
        if (openWithFiles.length > 0) {
          void tauriHandleOnCloseWindow(handleCloseBooks).catch((error) => {
            console.info('Failed to register close-window listener:', error);
          });
          return await tauriHandleClose();
        }
        const currentWindow = getCurrentWindow();
        if (currentWindow.label.startsWith('reader')) {
          return await currentWindow.close();
        }
      }
      saveSettingsAndGoToLibrary();
    }
  };

  if (!bookKeys || bookKeys.length === 0) {
    return (
      <div className='hero hero-content full-height'>
        <Spinner loading={true} />
      </div>
    );
  }
  const bookData = getBookData(bookKeys[0]!);
  const viewSettings = getViewSettings(bookKeys[0]!);
  if (!bookData || !bookData.book || !bookData.bookDoc || !viewSettings) {
    setTimeout(() => setLoading(true), 200);
    return (
      loading &&
      !errorLoading && (
        <div className='hero hero-content full-height'>
          <Spinner loading={true} />
        </div>
      )
    );
  }

  return (
    <div className='reader-content full-height flex'>
      <SideBar />
      <BooksGrid
        bookKeys={bookKeys}
        onCloseBook={handleCloseBook}
        onGoToLibrary={handleCloseBooksToLibrary}
      />
      {isSettingsDialogOpen && <SettingsDialog bookKey={settingsDialogBookKey} />}
      {audiobookBookKey && getBookData(audiobookBookKey)?.bookDoc && (
        <AudiobookPairingDialog
          bookKey={audiobookBookKey}
          bookDoc={getBookData(audiobookBookKey)!.bookDoc!}
          onClose={() => setAudiobookBookKey(null)}
        />
      )}
      {hardcoverLinkBookKey && (
        <HardcoverLinkDialog
          bookKey={hardcoverLinkBookKey}
          onClose={() => setHardcoverLinkBookKey(null)}
        />
      )}
      <LazyNotebook isPinned={settings.globalReadSettings.isNotebookPinned} />
      <LocalSendManager />
      {showDetailsBook && (
        <BookDetailModal
          isOpen={!!showDetailsBook}
          book={showDetailsBook}
          onClose={() => setShowDetailsBook(null)}
        />
      )}
      {shareDialogState && (
        <ShareBookDialog
          isOpen={true}
          book={shareDialogState.book}
          cfi={shareDialogState.cfi}
          onClose={() => setShareDialogState(null)}
        />
      )}
    </div>
  );
};

export default ReaderContent;
