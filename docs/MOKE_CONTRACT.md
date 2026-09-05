# Moke embedding contract (`moke.readest.embed.v1`)

## Runtime boundary

Reader is a static Next.js export plus an in-process Rust library. Moke owns the application lifecycle, server selection, authentication session, static asset origin and top-level Tauri configuration. Reader owns parsing/rendering, reading state and Reader UI.

There is no network listener between Moke and Reader. Their connection uses same-origin navigation, Tauri IPC and initialization/query context.

## Static route and launch context

Moke bundles `out/readest` and opens `/readest/reader`.

| Parameter/global | Meaning |
| --- | --- |
| `file` / `window.OPEN_WITH_FILES` | A local path already authorized by Moke's native index, file picker or Tauri fs scope. |
| `moke=1` / `window.__MOKE_EMBEDDED` | Enables host integration. |
| `mokeBookId` | Talebook book ID used by the progress API. |
| `mokeServerUrl` | Absolute HTTP(S) Talebook base URL. Omitted on desktop while Moke's main window owns progress saving. |
| `mokeRestoreProgress` | URL-encoded JSON using `moke.readest.progress.v1`. |
| `mokeReturnTo=/library` | The only allowed host return path. |
| `mokeEink`, `mokeDebug` | `0`/`1` host presentation flags. |

Moke accepts server URLs only through its server configuration flow. Reader does not evaluate arbitrary return URLs and never accepts credentials in query parameters.

## Native API

Moke links `readestlib` with `default-features = false` and calls:

- `register_reader_plugins(builder)`
- `register_reader_protocols(builder)`
- `reader_invoke_handler()`
- `manage_reader_state(app_handle)`

Desktop may call the `open_reader` command. Android uses the registered `rangefile` protocol for scoped byte ranges. Moke must keep the Reader plugins that expose Tauri permission manifests as direct dependencies; Cargo `links` metadata does not propagate through a transitive library.

## Events and errors

Reader sends `book:opened`, `page:changed`, `book:closed`, annotation-location receipts and `reader:error` through Moke's `ext_reader_event` command. High-frequency ordinary page events are throttled. The error payload contains a stable code and non-secret status metadata, not request headers, cookies or server credentials.

Reader also dispatches a browser `moke:reader-error` `CustomEvent` so the embedded debug panel and E2E harness can observe the same failure when host IPC is unavailable.

Progress failures are best effort: they do not interrupt rendering, are visible as `reader:error`, and are retried on a later page change or close flush.

## Talebook HTTP contract

On single-WebView platforms the Moke main React tree is unloaded while Reader is active, so Reader performs:

```text
POST {mokeServerUrl}/api/book/{mokeBookId}/progress
Content-Type: application/json
credentials: include

{"progress": {"schema": "moke.readest.progress.v1", ...}}
```

The request uses `@tauri-apps/plugin-http` so Moke's Rust cookie jar carries the authenticated Talebook session. Plain HTTP LAN servers, self-signed certificates and redirects are controlled by Moke's Tauri HTTP configuration. Moke's `http` ACL must allow the selected HTTP(S) origin.

A non-2xx response, redirected login/non-JSON response, or JSON envelope with `err` other than empty/`ok` is reported as a stable Reader error.

### CORS

Packaged Tauri requests are issued by the Rust HTTP plugin and are not browser CORS requests. Browser-only development uses native `fetch` semantics and therefore requires the Talebook origin to allow the development origin; production Moke does not rely on that exception.

## Versioning

Compatible additions keep `moke.readest.embed.v1`. Removing a launch field, command, event or changing progress semantics requires a new contract version and coordinated releases in both repositories.
