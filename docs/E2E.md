# Real Moke end-to-end verification

This lane uses the real Moke Tauri host, the real `readestlib` backend, a real EPUB file and a real Talebook server/session. Unit-test request doubles do not satisfy this lane.

## Environment

- Linux with GTK 3, WebKitGTK 4.1 and Xvfb (or a desktop session)
- Node.js/pnpm and Rust versions from the root README
- a reachable Talebook instance containing a test account and at least one EPUB
- credentials supplied interactively or through ignored local environment/configuration; never put them in command arguments, committed files, screenshots or logs

## Procedure

1. Clone Moke recursively and confirm its `readest` submodule URL is `https://github.com/269289854/readest-reader.git`.
2. Install both workspaces and run `pnpm build:reader` in Moke.
3. Start Moke with its Tauri E2E/WebDriver feature under the desktop session.
4. In Moke, configure the Talebook server, authenticate, open an EPUB from its detail/shelf flow, and wait for the dedicated Reader window.
5. Assert the Reader window reports `book:opened`, contains rendered chapter text inside the Foliate view, and emits `page:changed` after navigation.
6. Save/restore progress, close Reader, reopen the same book, and assert the rendered location is restored.
7. Make the configured progress endpoint unavailable (without exposing credentials), turn one page, and assert `reader:error` / the Moke debug panel records the stable error code while the chapter remains rendered.

## Evidence to retain

Record sanitized command results, commit IDs, platform versions, the Talebook origin without credentials, and screenshots showing Moke → Reader → rendered chapter plus the observable error state. Do not record cookies, authorization headers, access codes, passwords or query strings containing private data.
