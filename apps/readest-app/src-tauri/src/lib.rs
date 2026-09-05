#[cfg(target_os = "macos")]
#[macro_use]
extern crate cocoa;

#[cfg(target_os = "macos")]
#[macro_use]
extern crate objc;

#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "android")]
mod android;

use tauri::utils::config::BackgroundThrottlingPolicy;
#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_fs::FsExt;

#[cfg(desktop)]
use tauri::{Listener, Url};
mod clip_url;
mod cover_thumbnail;
mod dir_scanner;
#[cfg(any(
    target_os = "macos",
    target_os = "windows",
    all(target_os = "linux", not(target_env = "ohos"))
))]
mod discord_rpc;
mod epub_parser;
mod localsend;
#[cfg(target_os = "macos")]
mod macos;
mod mobi_parser;
// Moke embedded reader: the nightly updater (tauri-plugin-updater) is disabled.
// mod nightly_update;
mod parser_common;
mod range_file;
mod sentry_config;
#[cfg(desktop)]
mod spawn_fresh_browser;
mod transfer_file;
#[cfg(desktop)]
mod window_state;
#[cfg(target_os = "windows")]
use tauri::webview::ScrollBarStyle;
use tauri::{command, Emitter, WebviewUrl, WebviewWindowBuilder, Window};
#[cfg(target_os = "android")]
use tauri_plugin_native_bridge::register_select_directory_callback;
#[cfg(target_os = "android")]
use tauri_plugin_native_bridge::{NativeBridgeExt, OpenExternalUrlRequest};
use tauri_plugin_oauth::start;
#[cfg(not(target_os = "android"))]
use tauri_plugin_opener::OpenerExt;
use transfer_file::{download_file, upload_file};

#[cfg(any(desktop, target_os = "ios"))]
fn allow_file_in_scopes(app: &AppHandle, files: Vec<PathBuf>) {
    let fs_scope = app.fs_scope();
    let asset_protocol_scope = app.asset_protocol_scope();
    for file in &files {
        if let Err(e) = fs_scope.allow_file(file) {
            log::error!("Failed to allow file in fs_scope: {e}");
        } else {
            log::debug!("Allowed file in fs_scope: {file:?}");
        }
        if let Err(e) = asset_protocol_scope.allow_file(file) {
            log::error!("Failed to allow file in asset_protocol_scope: {e}");
        } else {
            log::debug!("Allowed file in asset_protocol_scope: {file:?}");
        }
    }
}

fn allow_dir_in_scopes(app: &AppHandle, dir: &PathBuf) {
    let fs_scope = app.fs_scope();
    let asset_protocol_scope = app.asset_protocol_scope();
    if let Err(e) = fs_scope.allow_directory(dir, true) {
        log::error!("Failed to allow directory in fs_scope: {e}");
    } else {
        log::info!("Allowed directory in fs_scope: {dir:?}");
    }
    if let Err(e) = asset_protocol_scope.allow_directory(dir, true) {
        log::error!("Failed to allow directory in asset_protocol_scope: {e}");
    } else {
        log::info!("Allowed directory in asset_protocol_scope: {dir:?}");
    }
}

/// Frontend-callable shim around [`allow_file_in_scopes`] /
/// [`allow_dir_in_scopes`]. Used after dialog-based file/folder pickers
/// because the Tauri `dialog` plugin only auto-grants `fs_scope`, not
/// `asset_protocol_scope` — and our importer relies on the asset
/// protocol (`RemoteFile`) to read user-selected files. Without this,
/// importing a book from e.g. `~/Downloads/...` fails with
/// "asset protocol not configured to allow the path".
///
/// Granted scopes are persisted across app restarts thanks to
/// `tauri_plugin_persisted_scope`, so re-picking the same file isn't
/// required after the first allow call.
///
/// Security:
///
///   - On desktop, this command refuses to extend `asset_protocol_scope`
///     for any path that is not already allowed in `fs_scope`. The
///     `fs_scope` there is populated only by the Tauri `dialog` plugin
///     (when the user picks through the OS picker) or by
///     `tauri_plugin_persisted_scope` (which restores prior dialog
///     grants on startup). That gate constrains the command to
///     user-selected paths only — otherwise any frontend code
///     (including a future XSS via book content, OPDS HTML, dictionary
///     lookups, or a compromised dependency) could invoke it with an
///     arbitrary path like `/` or `~/.ssh` and gain persistent read
///     access to the entire user home directory via the asset
///     protocol.
///
///   - On iOS, the `fs_scope` gate is intentionally skipped: the iOS
///     directory/file picker (`UIDocumentPickerViewController`) does
///     not flow through Tauri's dialog plugin, and we keep the only
///     persistent record of user-authorised paths inside the
///     native-bridge plugin's security-scoped bookmark store
///     (`FolderBookmarkStore` in NativeBridgePlugin.swift). The
///     OS sandbox itself is the access-control boundary: the process
///     can only read paths for which it holds a security-scoped
///     resource (granted by the system picker, persisted via
///     bookmark). Widening Tauri's `fs_scope`/`asset_protocol_scope`
///     to those same paths cannot escalate access beyond what the OS
///     already grants — it just lets the fs / dir-scanner layers
///     route reads through the path the WebView gave them. The
///     frontend layer also keeps the list of folder roots in
///     `settings.externalLibraryFolders` and re-issues this call on
///     every launch, so the in-memory scope set stays in sync with
///     the user's persisted intent.
#[command]
fn allow_paths_in_scopes(_app: AppHandle, _paths: Vec<String>, _is_directory: bool) {
    #[cfg(desktop)]
    {
        let fs_scope = _app.fs_scope();
        for raw in _paths {
            if raw.is_empty() {
                continue;
            }
            let path = PathBuf::from(&raw);
            if !fs_scope.is_allowed(&path) {
                log::warn!("allow_paths_in_scopes refused (path not in fs_scope): {path:?}");
                continue;
            }
            if _is_directory {
                allow_dir_in_scopes(&_app, &path);
            } else {
                allow_file_in_scopes(&_app, vec![path]);
            }
        }
    }
    #[cfg(target_os = "ios")]
    {
        // The iOS picker hands us a security-scoped URL whose POSIX
        // path lives outside any of our static fs_scope globs (e.g.
        // File Provider Storage, iCloud Drive, third-party providers).
        // Without explicitly widening fs_scope/asset_protocol_scope
        // here, both `dir_scanner::read_dir` and the fs plugin's
        // `readDir` would reject the path even though the OS sandbox
        // already grants us access via the held security-scoped
        // resource. See the security comment above.
        for raw in _paths {
            if raw.is_empty() {
                continue;
            }
            let path = PathBuf::from(&raw);
            if _is_directory {
                allow_dir_in_scopes(&_app, &path);
            } else {
                allow_file_in_scopes(&_app, vec![path]);
            }
        }
    }
    #[cfg(target_os = "android")]
    {
        // Android picker already routes through register_select_directory_callback
        // for directories; files go through SAF / content-URIs and don't use
        // asset_protocol_scope. Nothing to do here.
    }
}

#[cfg(desktop)]
fn get_files_from_argv(argv: Vec<String>) -> Vec<PathBuf> {
    let mut files = Vec::new();
    // NOTICE: `args` may include URL protocol (`your-app-protocol://`)
    // or arguments (`--`) if your app supports them.
    // files may also be passed as `file://path/to/file`
    for (_, maybe_file) in argv.iter().enumerate().skip(1) {
        // skip flags like -f or --flag
        if maybe_file.starts_with("-") {
            continue;
        }
        // handle `file://` path urls and skip other urls
        if let Ok(url) = Url::parse(maybe_file) {
            if let Ok(path) = url.to_file_path() {
                files.push(path);
            } else {
                files.push(PathBuf::from(maybe_file))
            }
        } else {
            files.push(PathBuf::from(maybe_file))
        }
    }
    files
}

#[cfg(desktop)]
fn set_window_open_with_files(app: &AppHandle, files: Vec<PathBuf>) {
    let files = files
        .into_iter()
        .map(|f| {
            let file = f
                .to_string_lossy()
                .replace("\\", "\\\\")
                .replace("\"", "\\\"");
            format!("\"{file}\"",)
        })
        .collect::<Vec<_>>()
        .join(",");
    let window = app.get_webview_window("main").unwrap();
    let script = format!("window.OPEN_WITH_FILES = [{files}];");
    if let Err(e) = window.eval(&script) {
        eprintln!("Failed to set open files variable: {e}");
    }
}

#[command]
async fn start_server(window: Window) -> Result<u16, String> {
    start(move |url| {
        // Because of the unprotected localhost port, you must verify the URL here.
        // Preferebly send back only the token, or nothing at all if you can handle everything else in Rust.
        let _ = window.emit("redirect_uri", url);
    })
    .map_err(|err| err.to_string())
}

#[tauri::command]
#[allow(dead_code)] // registered only by the standalone entry point; not exposed to the embedded (Moke) reader handler
fn get_environment_variable(name: &str) -> String {
    std::env::var(String::from(name)).unwrap_or(String::from(""))
}

#[tauri::command]
fn get_executable_dir() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|p| p.to_path_buf()))
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

// Pure decision for whether the in-app updater should be hidden. Kept
// dependency-free so it can be unit tested for every platform combination.
//
// - `env_disable`: READEST_DISABLE_UPDATER is set (explicit opt-out).
// - Linux only: Tauri's updater can self-update AppImage bundles *only*, so
//   deb/rpm/pacman (`!is_appimage`) and Flatpak installs are updated by the
//   system package manager and must not show the in-app updater.
#[cfg(desktop)]
fn compute_updater_disabled(
    env_disable: bool,
    is_linux: bool,
    is_flatpak: bool,
    is_appimage: bool,
) -> bool {
    env_disable || (is_linux && (is_flatpak || !is_appimage))
}

#[cfg(desktop)]
fn updater_disabled() -> bool {
    let env_disable = std::env::var("READEST_DISABLE_UPDATER").is_ok();
    #[cfg(target_os = "linux")]
    {
        let is_flatpak =
            std::env::var("FLATPAK_ID").is_ok() || std::path::Path::new("/.flatpak-info").exists();
        let is_appimage = std::env::var("APPIMAGE").is_ok()
            || std::env::current_exe()
                .map(|path| path.to_string_lossy().contains("/tmp/.mount_"))
                .unwrap_or(false);
        compute_updater_disabled(env_disable, true, is_flatpak, is_appimage)
    }
    #[cfg(not(target_os = "linux"))]
    {
        compute_updater_disabled(env_disable, false, false, false)
    }
}

// Authoritative source of truth for the frontend `hasUpdater` capability.
// Read via IPC in `NativeAppService.init()` so the decision does not depend on
// the injected init-script global, which is not reliably visible to page
// scripts on every Linux/WebKitGTK setup (see issue #4874).
#[cfg(desktop)]
#[tauri::command]
fn is_updater_disabled() -> bool {
    updater_disabled()
}

// Record the WebView engine/version (parsed from the app's User-Agent) so Sentry
// events can be correlated with WebView version. Called once from
// `NativeAppService.init()`; no-op when Sentry is disabled.
#[tauri::command]
fn set_webview_info(user_agent: String) {
    if let Some((engine, version)) = sentry_config::parse_webview_info(&user_agent) {
        sentry_config::set_webview_info(engine, version);
    }
}

#[derive(Clone, serde::Serialize)]
#[allow(dead_code)]
struct SingleInstancePayload {
    args: Vec<String>,
    cwd: String,
}

/// Register the reader (readest) backend plugins onto an existing Tauri
/// builder. This is the integration entry point used when readest is embedded
/// in a host app (Moke) instead of running standalone.
///
/// The host owns the base plugins it also needs on its own
/// (`fs`, `http`, `os`, `shell`, `opener`), so they are intentionally NOT
/// registered here — registering a plugin twice panics. This adds only the
/// extra plugins the reader frontend relies on.
pub fn register_reader_plugins(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    let builder = builder
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("tracing", log::LevelFilter::Warn)
                .level_for("tantivy", log::LevelFilter::Warn)
                .build(),
        )
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_oauth::init())
        .plugin(tauri_plugin_device_info::init())
        .plugin(tauri_plugin_turso::init())
        .plugin(tauri_plugin_native_bridge::init())
        .plugin(tauri_plugin_native_tts::init());

    // Desktop-only plugins. tauri-plugin-dialog pulls in `rfd` (gtk-sys /
    // glib-sys) which cannot cross-compile to OHOS; the clipboard-manager
    // backend (arboard) is likewise desktop-only. Cargo.toml gates these
    // deps to `any(macos, windows, all(linux, not(ohos)))`, so the cfg here
    // must match exactly — `not(ohos)` alone would also compile them on
    // iOS/Android where the crates don't exist.
    #[cfg(any(
        target_os = "macos",
        target_os = "windows",
        all(target_os = "linux", not(target_env = "ohos"))
    ))]
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init());

    builder
}

/// Register reader URI protocols on an embedding host's Tauri builder.
///
/// Android uses `rangefile` for local ebook byte-range reads because the
/// WebView corrupts ordinary asset-protocol range responses. Hosts embedding
/// Readest must register it just like the standalone application does.
pub fn register_reader_protocols(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    builder.register_asynchronous_uri_scheme_protocol(range_file::SCHEME, range_file::handle)
}

/// Manage reader-related app state. Call once from the host app's `setup`.
pub fn manage_reader_state(app: &AppHandle) {
    app.manage(localsend::LocalSendState::default());

    #[cfg(any(
        target_os = "macos",
        target_os = "windows",
        all(target_os = "linux", not(target_env = "ohos"))
    ))]
    {
        use std::sync::{Arc, Mutex};
        let discord_client = Arc::new(Mutex::new(discord_rpc::DiscordRpcClient::new()));
        app.manage(discord_client);
    }
}

/// Open a reader window that loads the embedded readest frontend (served by
/// the host app under `/readest`). The book to open is handed to the frontend
/// via `window.OPEN_WITH_FILES`, matching readest's standalone file-open path.
///
/// Each call creates a fresh `reader-<n>` window; the label prefix matches the
/// `reader-*` capability pattern so the window inherits the right permissions.
///
/// HOU-15 H2: before widening the persistent fs/asset scopes we require the
/// path to be either a Moke-downloaded book (`app_data_dir()/books`) or already
/// allowed in `fs_scope`. Kept as a pure, dependency-free decision so it can be
/// unit-tested without a running Tauri app.
#[cfg(desktop)]
fn is_reader_scope_grantable(books_dir: Option<&Path>, fs_allowed: bool, path: &Path) -> bool {
    let in_books_dir = match books_dir {
        Some(books_dir) => path.starts_with(books_dir),
        None => false,
    };
    in_books_dir || fs_allowed
}

#[cfg(all(test, desktop))]
mod open_reader_scope_tests {
    use super::*;

    #[test]
    fn refuses_paths_outside_books_dir_and_fs_scope() {
        let books_dir = Path::new("/home/u/AppData/app/books");
        let path = Path::new("/home/u/.ssh/id_rsa");
        assert!(!is_reader_scope_grantable(Some(books_dir), false, path));
        assert!(!is_reader_scope_grantable(None, false, path));
    }

    #[test]
    fn allows_paths_inside_books_dir() {
        let books_dir = Path::new("/home/u/AppData/app/books");
        let path = Path::new("/home/u/AppData/app/books/2024/foo.epub");
        assert!(is_reader_scope_grantable(Some(books_dir), false, path));
    }

    #[test]
    fn refuses_sibling_prefix_like_books_evil() {
        let books_dir = Path::new("/home/u/AppData/app/books");
        // `/booksX/...` is not under `/books` (Path::starts_with is component-wise).
        let path = Path::new("/home/u/AppData/app/booksX/foo.epub");
        assert!(!is_reader_scope_grantable(Some(books_dir), false, path));
    }

    #[test]
    fn allows_paths_already_allowed_in_fs_scope() {
        let books_dir = Path::new("/home/u/AppData/app/books");
        let picked = Path::new("/home/u/Downloads/foo.epub");
        assert!(is_reader_scope_grantable(Some(books_dir), true, picked));
    }
}

#[cfg(desktop)]
pub fn open_reader_window(
    app: &AppHandle,
    file: Option<PathBuf>,
    eink: bool,
    moke_book_id: Option<String>,
    restore_progress: Option<serde_json::Value>,
) -> Result<(), String> {
    open_reader_window_with_debug(app, file, eink, false, moke_book_id, restore_progress, None)
}

#[cfg(desktop)]
fn open_reader_window_with_debug(
    app: &AppHandle,
    file: Option<PathBuf>,
    eink: bool,
    debug_panel: bool,
    moke_book_id: Option<String>,
    restore_progress: Option<serde_json::Value>,
    moke_source: Option<serde_json::Value>,
) -> Result<(), String> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static READER_SEQ: AtomicUsize = AtomicUsize::new(0);

    if let Some(ref f) = file {
        // Only grant fs/asset scopes for a path the host is allowed to hand
        // to the reader: either a Moke-downloaded book under
        // `app_data_dir()/books`, or a path already present in `fs_scope`
        // (e.g. user-picked through the OS dialog and granted by the dialog
        // plugin). Mirrors the `fs_scope.is_allowed` gate used by
        // `allow_paths_in_scopes`; without it, any webview script (including
        // malicious book content) could invoke `open_reader` with an
        // arbitrary path and permanently widen the persistent fs/asset scopes.
        let books_dir = app.path().app_data_dir().map(|dir| dir.join("books"));
        if is_reader_scope_grantable(books_dir.ok().as_deref(), app.fs_scope().is_allowed(f), f) {
            allow_file_in_scopes(app, vec![f.clone()]);
        } else {
            log::warn!(
                "open_reader refused scope grant for path outside books dir / fs_scope: {f:?}"
            );
        }
    }

    let files_js = match &file {
        Some(f) => {
            let s = f
                .to_string_lossy()
                .replace('\\', "\\\\")
                .replace('"', "\\\"");
            format!("[\"{s}\"]")
        }
        None => "[]".to_string(),
    };

    // ponytail: host (Moke) forwards its e-ink toggle so the embedded reader
    // boots in e-ink mode on devices the CSS media query can't detect (desktop WebView).
    let eink_js = if eink { "true" } else { "false" };
    let debug_panel_js = if debug_panel { "true" } else { "false" };
    let moke_book_id_js = serde_json::to_string(&moke_book_id).map_err(|e| e.to_string())?;
    let restore_progress_js =
        serde_json::to_string(&restore_progress).map_err(|e| e.to_string())?;
    let moke_source_js = serde_json::to_string(&moke_source).map_err(|e| e.to_string())?;

    let init_script = format!(
        r#"
            window.OPEN_WITH_FILES = {files_js};
            window.__MOKE_EMBEDDED = true;
            window.__MOKE_EINK = {eink_js};
            window.__MOKE_DEBUG_PANEL = {debug_panel_js};
            window.__MOKE_BOOK_ID = {moke_book_id_js};
            window.__MOKE_RESTORE_PROGRESS = {restore_progress_js};
            window.__MOKE_BOOK_SOURCE = {moke_source_js};
            window.addEventListener('DOMContentLoaded', function() {{
                document.documentElement.classList.add('edge-to-edge');
            }});
        "#
    );

    let n = READER_SEQ.fetch_add(1, Ordering::Relaxed);
    let label = format!("reader-{n}");

    // WebView2 (Windows) must be created on the main/UI thread. `open_reader`
    // is an async command (worker thread), and building the webview off the
    // main thread fails with HRESULT 0x8007139F (ERROR_INVALID_STATE). Post the
    // creation to the main thread, fire-and-forget, so we never block or
    // deadlock the IPC caller; any failure is logged. Kept to a plain window
    // (native decorations, no transparency/custom scrollbar) for maximum
    // compatibility — chrome can be refined once it opens reliably.
    let app_main = app.clone();
    app.run_on_main_thread(move || {
        // Production reads the bundled export. Debug builds use the dedicated
        // Reader dev server started by Moke's scripts/dev.mjs; resolving an
        // App URL against Moke's own port 3000 would load the wrong Next app.
        #[cfg(debug_assertions)]
        let reader_url = WebviewUrl::External(
            Url::parse("http://localhost:3001/readest/reader")
                .expect("valid Reader development URL"),
        );
        #[cfg(not(debug_assertions))]
        let reader_url = WebviewUrl::App("readest/reader.html".into());

        let result = WebviewWindowBuilder::new(&app_main, label, reader_url)
            .title("Readest")
            .inner_size(1280.0, 800.0)
            .min_inner_size(800.0, 600.0)
            .resizable(true)
            .initialization_script(&init_script)
            .build();
        if let Err(e) = result {
            log::error!("failed to open reader window: {e}");
        }
    })
    .map_err(|e| e.to_string())
}

#[cfg(desktop)]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MokeReaderSourceValidation {
    kind: String,
    identity: String,
    cache_scope: String,
    cache_limit_bytes: u64,
    book_id: String,
    format: String,
    title: String,
    author: String,
    file_path: Option<String>,
    server_url: Option<String>,
    url: Option<String>,
}

#[cfg(desktop)]
fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(desktop)]
fn validate_moke_reader_source(
    value: &serde_json::Value,
    command_file_path: Option<&str>,
) -> Result<(), String> {
    let source: MokeReaderSourceValidation =
        serde_json::from_value(value.clone()).map_err(|_| "invalid Moke source".to_string())?;
    if !source.identity.starts_with("moke")
        || !is_lower_hex(&source.identity[4..], 16)
        || !is_lower_hex(&source.cache_scope, 16)
        || source.book_id.is_empty()
        || !source.book_id.bytes().all(|byte| byte.is_ascii_digit())
        || source.format.is_empty()
        || source.format.len() > 16
        || !source
            .format
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric())
        || source.title.len() > 16 * 1024
        || source.author.len() > 16 * 1024
        || !(64 * 1024 * 1024..=4 * 1024 * 1024 * 1024).contains(&source.cache_limit_bytes)
    {
        return Err("invalid Moke source metadata".into());
    }

    match source.kind.as_str() {
        "local" => {
            let source_path = source
                .file_path
                .as_deref()
                .filter(|path| !path.is_empty())
                .ok_or_else(|| "local Moke source requires filePath".to_string())?;
            if command_file_path != Some(source_path) {
                return Err("local Moke source filePath mismatch".into());
            }
        }
        "remote" => {
            if command_file_path.is_some() || !matches!(source.format.as_str(), "epub" | "pdf") {
                return Err("remote Moke source must be EPUB or PDF".into());
            }
            let server = Url::parse(
                source
                    .server_url
                    .as_deref()
                    .ok_or_else(|| "remote Moke source requires serverUrl".to_string())?,
            )
            .map_err(|_| "invalid Moke serverUrl".to_string())?;
            let remote = Url::parse(
                source
                    .url
                    .as_deref()
                    .ok_or_else(|| "remote Moke source requires url".to_string())?,
            )
            .map_err(|_| "invalid Moke source url".to_string())?;
            if !matches!(server.scheme(), "http" | "https")
                || !server.username().is_empty()
                || server.password().is_some()
                || server.query().is_some()
                || server.fragment().is_some()
                || !remote.username().is_empty()
                || remote.password().is_some()
                || remote.fragment().is_some()
                || remote.origin() != server.origin()
            {
                return Err("remote Moke source is outside the configured server".into());
            }
            let expected_path = format!(
                "{}/api/book/{}.{}",
                server.path().trim_end_matches('/'),
                source.book_id,
                source.format
            );
            if remote.path() != expected_path || remote.query() != Some("mode=read") {
                return Err("remote Moke source is outside the reading endpoint".into());
            }
        }
        _ => return Err("unsupported Moke source kind".into()),
    }
    Ok(())
}

#[cfg(all(test, desktop))]
mod moke_reader_source_validation_tests {
    use super::validate_moke_reader_source;
    use serde_json::json;

    fn remote_source() -> serde_json::Value {
        json!({
            "kind": "remote",
            "identity": "moke0123456789abcdef",
            "cacheScope": "0123456789abcdef",
            "cacheLimitBytes": 384 * 1024 * 1024,
            "bookId": "42",
            "format": "epub",
            "title": "Sample",
            "author": "Author",
            "serverUrl": "https://books.test/library",
            "url": "https://books.test/library/api/book/42.epub?mode=read"
        })
    }

    #[test]
    fn remote_source_is_limited_to_the_configured_read_endpoint() {
        let source = remote_source();
        assert!(validate_moke_reader_source(&source, None).is_ok());

        let mut wrong_origin = source.clone();
        wrong_origin["url"] = json!("https://other.test/library/api/book/42.epub?mode=read");
        assert!(validate_moke_reader_source(&wrong_origin, None).is_err());

        let mut wrong_query = source.clone();
        wrong_query["url"] = json!("https://books.test/library/api/book/42.epub?mode=download");
        assert!(validate_moke_reader_source(&wrong_query, None).is_err());

        let mut traversal_scope = source;
        traversal_scope["cacheScope"] = json!("../outside");
        assert!(validate_moke_reader_source(&traversal_scope, None).is_err());
    }

    #[test]
    fn local_source_must_match_the_separately_authorized_file_path() {
        let source = json!({
            "kind": "local",
            "identity": "moke0123456789abcdef",
            "cacheScope": "0123456789abcdef",
            "cacheLimitBytes": 384 * 1024 * 1024,
            "bookId": "42",
            "format": "txt",
            "title": "Sample",
            "author": "Author",
            "filePath": "C:\\Books\\sample.txt"
        });
        assert!(validate_moke_reader_source(&source, Some("C:\\Books\\sample.txt")).is_ok());
        assert!(validate_moke_reader_source(&source, Some("C:\\Books\\other.txt")).is_err());
    }
}

/// Frontend entry command for the embedded host (Moke). Mirrors the host's
/// previous `open_reader` contract (`invoke('open_reader', { filePath })`) but
/// now opens an in-process reader window instead of spawning a separate exe.
#[cfg(desktop)]
#[tauri::command]
async fn open_reader(
    app: AppHandle,
    file_path: Option<String>,
    eink: bool,
    debug_panel: Option<bool>,
    moke_book_id: Option<String>,
    restore_progress: Option<serde_json::Value>,
    moke_source: Option<serde_json::Value>,
) -> Result<(), String> {
    if file_path.is_none() && moke_source.is_none() {
        return Err("open_reader requires filePath or mokeSource".into());
    }
    if let Some(source) = moke_source.as_ref() {
        validate_moke_reader_source(source, file_path.as_deref())?;
    }
    open_reader_window_with_debug(
        &app,
        file_path.map(PathBuf::from),
        eink,
        debug_panel.unwrap_or(false),
        moke_book_id,
        restore_progress,
        moke_source,
    )
}

/// The full app-level invoke handler for the reader backend, exposed so an
/// embedding host (Moke) can install it with a single
/// `.invoke_handler(readestlib::reader_invoke_handler())`.
///
/// The reader frontend calls these commands by bare name (e.g.
/// `invoke('parse_epub_full')`), so they must live on the app-level handler,
/// not behind a plugin namespace. Building the handler here (inside the crate
/// that defines the commands) keeps the command macros in scope and avoids the
/// crate-root `pub fn` re-export collision that arises when listing them from
/// another crate.
pub fn reader_invoke_handler(
) -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        #[cfg(desktop)]
        open_reader,
        start_server,
        download_file,
        upload_file,
        get_executable_dir,
        allow_paths_in_scopes,
        dir_scanner::read_dir,
        epub_parser::parse_epub_metadata,
        epub_parser::extract_epub_cover_full,
        epub_parser::parse_epub_full,
        mobi_parser::parse_mobi_metadata,
        mobi_parser::extract_mobi_cover_full,
        #[cfg(any(
            target_os = "macos",
            target_os = "windows",
            all(target_os = "linux", not(target_env = "ohos"))
        ))]
        discord_rpc::update_book_presence,
        #[cfg(any(
            target_os = "macos",
            target_os = "windows",
            all(target_os = "linux", not(target_env = "ohos"))
        ))]
        discord_rpc::clear_book_presence,
        clip_url::clip_url,
        localsend::commands::localsend_start,
        localsend::commands::localsend_stop,
        localsend::commands::localsend_get_status,
        localsend::commands::localsend_list_devices,
        localsend::commands::localsend_announce,
        localsend::commands::localsend_respond,
        localsend::commands::localsend_cancel_receive,
        localsend::commands::localsend_send_files,
        localsend::commands::localsend_cancel_send,
    ]
}

#[cfg(feature = "standalone")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize Sentry as early as possible so panics during startup are
    // captured. `None` DSN (unset SENTRY_DSN) => disabled, so local and fork
    // builds don't report. This client covers Rust panics and the events the
    // WebView forwards; native crashes belong to the sentry-android /
    // sentry-cocoa SDKs on mobile and go unreported on desktop, where the
    // out-of-process minidump handler is deliberately off (see the
    // `minidump_feature_is_enabled_on_no_target` test). The guard must outlive
    // the app, so it is held until `run()` returns (after the blocking
    // `.run(...)` call).
    let sentry_guard = sentry_config::sentry_dsn().map(|dsn| {
        sentry::init((
            dsn,
            sentry::ClientOptions {
                release: Some(sentry_config::sentry_release().into()),
                environment: Some(sentry_config::sentry_environment().into()),
                traces_sample_rate: 0.0,
                send_default_pii: false,
                // On Android the context integration reads `uname()` and reports
                // the OS as "Linux"; relabel it "Android" (and recover the Android
                // version from the kernel string) so events group correctly.
                before_send: Some(std::sync::Arc::new(|mut event| {
                    // Drop known-benign browser noise (e.g. View Transition
                    // skipped/aborted, ResizeObserver loop) before it is reported.
                    if event.exception.values.iter().any(|ex| {
                        ex.value
                            .as_deref()
                            .is_some_and(sentry_config::is_ignored_browser_error)
                    }) {
                        return None;
                    }
                    // Drop the contained MOBI cover panic: the `mobi` crate panics
                    // on a corrupt cover record, which extract_cover catch_unwinds
                    // (the import still succeeds), but the panic hook reports it
                    // anyway. Match our own frame so unrelated slice panics stay.
                    if event.exception.values.iter().any(|ex| {
                        ex.stacktrace.iter().any(|st| {
                            st.frames.iter().any(|f| {
                                f.function
                                    .as_deref()
                                    .is_some_and(sentry_config::is_mobi_cover_panic_frame)
                            })
                        })
                    }) {
                        return None;
                    }
                    if let Some(sentry::protocol::Context::Os(os)) = event.contexts.get_mut("os") {
                        if let Some(name) = sentry_config::corrected_os_name(
                            std::env::consts::OS,
                            os.name.as_deref(),
                        ) {
                            os.name = Some(name.to_owned());
                            if let Some(version) = os
                                .version
                                .as_deref()
                                .and_then(sentry_config::android_version_from_uname)
                            {
                                os.version = Some(version);
                            }
                        }
                    }
                    // Tag the WebView engine/version (reported by the app at
                    // startup) so crashes can be correlated with it.
                    if let Some((engine, version)) = sentry_config::webview_info() {
                        event
                            .tags
                            .insert("webview.engine".to_string(), engine.clone());
                        event
                            .tags
                            .insert("webview.version".to_string(), version.clone());
                    }
                    Some(event)
                })),
                ..Default::default()
            },
        ))
    });

    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("tracing", log::LevelFilter::Warn)
                .level_for("tantivy", log::LevelFilter::Warn)
                .build(),
        )
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_oauth::init())
        .invoke_handler(tauri::generate_handler![
            start_server,
            download_file,
            upload_file,
            get_environment_variable,
            get_executable_dir,
            set_webview_info,
            #[cfg(desktop)]
            is_updater_disabled,
            allow_paths_in_scopes,
            cover_thumbnail::optimize_cover_thumbnails,
            dir_scanner::read_dir,
            epub_parser::parse_epub_metadata,
            epub_parser::extract_epub_cover_full,
            epub_parser::parse_epub_full,
            mobi_parser::parse_mobi_metadata,
            mobi_parser::extract_mobi_cover_full,
            #[cfg(target_os = "macos")]
            macos::safari_auth::auth_with_safari,
            #[cfg(target_os = "macos")]
            macos::apple_auth::start_apple_sign_in,
            #[cfg(target_os = "macos")]
            macos::traffic_light::set_traffic_lights,
            #[cfg(target_os = "macos")]
            macos::system_dictionary::show_lookup_popover,
            #[cfg(any(
                target_os = "macos",
                target_os = "windows",
                all(target_os = "linux", not(target_env = "ohos"))
            ))]
            discord_rpc::update_book_presence,
            #[cfg(any(
                target_os = "macos",
                target_os = "windows",
                all(target_os = "linux", not(target_env = "ohos"))
            ))]
            discord_rpc::clear_book_presence,
            clip_url::clip_url,
            localsend::commands::localsend_start,
            localsend::commands::localsend_stop,
            localsend::commands::localsend_get_status,
            localsend::commands::localsend_list_devices,
            localsend::commands::localsend_announce,
            localsend::commands::localsend_respond,
            localsend::commands::localsend_cancel_receive,
            localsend::commands::localsend_send_files,
            localsend::commands::localsend_cancel_send,
            #[cfg(desktop)]
            spawn_fresh_browser::spawn_fresh_browser,
            // Moke embedded reader: nightly updater (tauri-plugin-updater) is disabled.
            // nightly_update::verify_update_signature,
            // #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
            // nightly_update::install_nightly_update,
        ])
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_os::init());

    // Desktop-only (see Cargo.toml): the dialog (rfd) and clipboard-manager
    // (arboard) backends are not available on mobile / OHOS.
    #[cfg(any(
        target_os = "macos",
        target_os = "windows",
        all(target_os = "linux", not(target_env = "ohos"))
    ))]
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init());

    let builder = builder
        .plugin(tauri_plugin_sharekit::init())
        .plugin(tauri_plugin_device_info::init())
        .plugin(tauri_plugin_turso::init())
        .plugin(tauri_plugin_native_bridge::init())
        .plugin(tauri_plugin_native_tts::init())
        .plugin(tauri_plugin_webview_upgrade::init())
        // Serves local file byte-ranges to `RemoteFile` via `?path=&start=&end=`
        // (range-in-URL, not a `Range` header) so Android's WebView doesn't
        // re-apply the offset. Scope-gated by `asset_protocol_scope`.
        .register_asynchronous_uri_scheme_protocol(range_file::SCHEME, range_file::handle);

    #[cfg(desktop)]
    let builder = builder.plugin(
        tauri_plugin_single_instance::Builder::new()
            .callback(move |app, argv, cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_focus();
                }
                let files = get_files_from_argv(argv.clone());
                if !files.is_empty() {
                    allow_file_in_scopes(app, files.clone());
                }
                app.emit("single-instance", SingleInstancePayload { args: argv, cwd })
                    .unwrap();
            })
            .dbus_id("com.bilingify.readest".to_owned())
            .build(),
    );

    let builder = builder.plugin(tauri_plugin_deep_link::init());

    // 更新系统已移除：不再注册 tauri_plugin_updater。

    // Strip invalid geometry from the saved window state before the
    // window-state plugin loads it, so a bad `.window-state.json` (e.g. the
    // Windows minimized `-32000` sentinel) can't crash WebView2 on launch.
    // See https://github.com/readest/readest/issues/4398.
    #[cfg(desktop)]
    let builder = builder.plugin(window_state::init());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(macos::traffic_light::init());

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(macos::window::init());

    #[cfg(target_os = "macos")]
    let builder = builder.plugin(macos::safari_auth::init());

    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_sign_in_with_apple::init());

    #[cfg(any(target_os = "ios", target_os = "android"))]
    let builder = builder.plugin(tauri_plugin_haptics::init());

    #[cfg(any(target_os = "ios", target_os = "android"))]
    let builder = builder.plugin(tauri_plugin_biometric::init());

    #[cfg(feature = "webdriver")]
    let builder = builder.plugin(tauri_plugin_webdriver::init());

    let builder = match sentry_guard.as_ref() {
        Some(client) => builder.plugin(tauri_plugin_sentry::init(client)),
        None => builder,
    };

    builder
        .setup(|#[allow(unused_variables)] app| {
            // When running with the webdriver feature (E2E/integration tests),
            // grant all default permissions to remote URLs (http://127.0.0.1:*)
            // so that Vitest browser-mode tests can call plugin commands.
            #[cfg(feature = "webdriver")]
            {
                use tauri::Manager;
                app.add_capability(include_str!("../capabilities-extra/webdriver.json"))?;
            }
            #[cfg(any(
                target_os = "macos",
                target_os = "windows",
                all(target_os = "linux", not(target_env = "ohos"))
            ))]
            {
                use std::sync::{Arc, Mutex};
                let discord_client = Arc::new(Mutex::new(discord_rpc::DiscordRpcClient::new()));
                app.manage(discord_client);
            }
            app.manage(localsend::LocalSendState::default());

            #[cfg(desktop)]
            {
                let files = get_files_from_argv(std::env::args().collect());
                if !files.is_empty() {
                    let app_handle = app.handle().clone();
                    allow_file_in_scopes(&app_handle, files.clone());
                    app.listen("window-ready", move |_| {
                        println!("Window is ready, proceeding to handle files.");
                        set_window_open_with_files(&app_handle, files.clone());
                    });
                }
            }

            #[cfg(desktop)]
            {
                allow_dir_in_scopes(app.handle(), &PathBuf::from(get_executable_dir()));
            }

            #[cfg(target_os = "android")]
            register_select_directory_callback(app.handle(), move |app, path| {
                allow_dir_in_scopes(app, path);
            });

            #[cfg(any(target_os = "windows", target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }

            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_cli::init())?;
            }

            // Check for e-ink device on Android before building the window
            #[cfg(target_os = "android")]
            let is_eink = android::is_eink_device();
            #[cfg(not(target_os = "android"))]
            let is_eink = false;

            #[cfg(desktop)]
            let cli_access = true;
            #[cfg(not(desktop))]
            let cli_access = false;

            #[cfg(target_os = "linux")]
            let is_appimage = std::env::var("APPIMAGE").is_ok()
                || std::env::current_exe()
                    .map(|path| path.to_string_lossy().contains("/tmp/.mount_"))
                    .unwrap_or(false);
            #[cfg(not(target_os = "linux"))]
            let is_appimage = false;

            // The in-app updater is hidden for installs it can't actually update
            // (Linux deb/rpm/pacman and Flatpak) and when READEST_DISABLE_UPDATER
            // is set. This mirrors the `is_updater_disabled` command that
            // `NativeAppService.init()` reads authoritatively; the injected global
            // below is only a best-effort fast path.
            #[cfg(desktop)]
            let updater_disabled = updater_disabled();
            #[cfg(not(desktop))]
            let updater_disabled = false;

            let init_script = format!(
                r#"
                    if ({is_eink}) window.__READEST_IS_EINK = true;
                    if ({cli_access}) window.__READEST_CLI_ACCESS = true;
                    if ({is_appimage}) window.__READEST_IS_APPIMAGE = true;
                    if ({updater_disabled}) window.__READEST_UPDATER_DISABLED = true;
                    window.addEventListener('DOMContentLoaded', function() {{
                        document.documentElement.classList.add('edge-to-edge');
                        const isTauriLocal = window.location.protocol === 'tauri:' ||
                                            window.location.protocol === 'about:' ||
                                            window.location.hostname === 'tauri.localhost';
                        const needsSafeArea = !isTauriLocal;
                        if (needsSafeArea && !document.getElementById('safe-area-style')) {{
                            const style = document.createElement('style');
                            style.id = 'safe-area-style';
                            style.textContent = `
                                body {{
                                    padding-top: env(safe-area-inset-top) !important;
                                    padding-bottom: env(safe-area-inset-bottom) !important;
                                    padding-left: env(safe-area-inset-left) !important;
                                    padding-right: env(safe-area-inset-right) !important;
                                }}
                            `;
                            document.head.appendChild(style);
                        }}
                    }});
                "#,
                is_eink = is_eink,
                cli_access = cli_access,
                is_appimage = is_appimage,
                updater_disabled = updater_disabled
            );

            let app_handle = app.handle().clone();
            let win_builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .background_throttling(BackgroundThrottlingPolicy::Disabled)
                .background_color(if is_eink {
                    tauri::window::Color(255, 255, 255, 255)
                } else {
                    tauri::window::Color(50, 49, 48, 255)
                })
                .initialization_script(&init_script)
                .on_navigation(move |url| {
                    if url.scheme() == "alipays" || url.scheme() == "alipay" {
                        let url_str = url.as_str().to_string();
                        #[cfg(target_os = "android")]
                        {
                            let handle = app_handle.clone();
                            tauri::async_runtime::spawn(async move {
                                match handle
                                    .native_bridge()
                                    .open_external_url(OpenExternalUrlRequest { url: url_str })
                                {
                                    Ok(result) => println!("Result: {:?}", result),
                                    Err(e) => eprintln!("Error: {:?}", e),
                                }
                            });
                        }
                        #[cfg(not(target_os = "android"))]
                        {
                            let _ = app_handle.opener().open_url(url_str, None::<&str>);
                        }
                        return false;
                    }
                    true
                });

            #[cfg(target_os = "macos")]
            let win_builder = win_builder.inner_size(1280.0, 800.0).resizable(true);
            #[cfg(all(not(target_os = "macos"), desktop))]
            let win_builder = win_builder.inner_size(800.0, 600.0).resizable(true);

            // The overlay title bar draws its title over the app's own header,
            // so `macos::window::init()` hides the title text and the window
            // can carry a real name for the Window menu and VoiceOver.
            #[cfg(target_os = "macos")]
            let win_builder = win_builder
                .decorations(true)
                .title_bar_style(TitleBarStyle::Overlay)
                .title("Readest");

            #[cfg(all(not(target_os = "macos"), desktop))]
            let win_builder = {
                let mut builder = win_builder
                    .decorations(false)
                    .visible(false)
                    .shadow(true)
                    .title("Readest");

                #[cfg(target_os = "windows")]
                {
                    builder = builder
                        .transparent(false)
                        .scroll_bar_style(ScrollBarStyle::FluentOverlay);
                }
                #[cfg(target_os = "linux")]
                {
                    // Keep the window opaque on Linux. A transparent WebKitGTK
                    // window (previously used to draw rounded corners, #1982)
                    // composites as fully transparent whenever its web process is
                    // too busy to repaint damaged regions (e.g. during a library
                    // backup), so the app "turns invisible" on any interaction
                    // (#3682). An opaque window instead retains its last painted
                    // frame, at the cost of square corners.
                    builder = builder.transparent(false);
                }

                builder
            };

            #[cfg(not(target_os = "macos"))]
            {
                win_builder.build().unwrap();
            }
            // let win = win_builder.build().unwrap();
            // win.open_devtools();

            #[cfg(target_os = "macos")]
            {
                let window = win_builder.build().unwrap();
                // On macOS, closing a window (via Cmd+W or the red traffic light)
                // should not quit the app — only Cmd+Q should — and normally hides
                // instead of minimizing (#5240): the app keeps running in the dock
                // and the window is restored when the user reopens the app from the
                // dock. On Tahoe the hide is defensive against the `orderOut:`
                // phantom-window regression (#4875); see
                // `macos::window::hide_main_window` for the fullscreen-failure
                // fallback.
                let window_for_close = window.clone();
                window.on_window_event(move |event| match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        macos::window::hide_main_window(&window_for_close);
                    }
                    // Safety net for JS-side `show()` callers (e.g.
                    // `ensureMainLibraryWindow` in src/utils/nav.ts re-shows a hidden
                    // main window from a reader window without a dock Reopen): the
                    // window can only become key after it is back on screen, so any
                    // pending defensively-zeroed frame must be restored by now.
                    tauri::WindowEvent::Focused(true) => {
                        macos::window::restore_main_window_frame(&window_for_close);
                    }
                    _ => {}
                });
            }

            #[cfg(target_os = "macos")]
            macos::menu::setup_macos_menu(app.handle())?;

            app.handle().emit("window-ready", ()).unwrap();

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(
            #[allow(unused_variables)]
            |app_handle, event| {
                #[cfg(target_os = "macos")]
                match event {
                    tauri::RunEvent::Opened { urls } => {
                        let files = urls
                            .into_iter()
                            .filter_map(|url| url.to_file_path().ok())
                            .collect::<Vec<_>>();

                        let app_handler_clone = app_handle.clone();
                        allow_file_in_scopes(app_handle, files.clone());
                        app_handle.listen("window-ready", move |_| {
                            println!("Window is ready, proceeding to handle files.");
                            set_window_open_with_files(&app_handler_clone, files.clone());
                        });
                    }
                    // When the user reopens the app from the dock after closing all
                    // windows, re-show the main window instead of leaving the dock
                    // icon inert.
                    tauri::RunEvent::Reopen {
                        has_visible_windows: false,
                        ..
                    } => {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            // Undo a pending Tahoe defensive hide (zeroed frame) before
                            // showing so the window reappears at its real position and
                            // size. No-op when the window was hidden plainly.
                            macos::window::restore_main_window_frame(&window);
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = window.unminimize();
                        }
                    }
                    // A programmatic exit emits ExitRequested before the window-state
                    // plugin performs its final save. Restore any zeroed frame while
                    // the window is still hidden so live geometry remains valid.
                    tauri::RunEvent::ExitRequested { .. } => {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            macos::window::restore_main_window_frame(&window);
                        }
                    }
                    _ => {}
                }
            },
        );
}

#[cfg(all(test, desktop))]
mod tests {
    use super::compute_updater_disabled;

    #[test]
    fn env_opt_out_disables_on_any_desktop() {
        // READEST_DISABLE_UPDATER is an explicit opt-out on every desktop OS.
        assert!(compute_updater_disabled(true, false, false, false));
        assert!(compute_updater_disabled(true, true, false, true));
    }

    #[test]
    fn linux_system_package_install_is_disabled() {
        // deb/rpm/pacman installs are not AppImage and not Flatpak. Tauri's
        // Linux updater can't self-update them, so the in-app updater is hidden.
        assert!(compute_updater_disabled(false, true, false, false));
    }

    #[test]
    fn linux_flatpak_is_disabled() {
        assert!(compute_updater_disabled(false, true, true, false));
    }

    #[test]
    fn linux_appimage_keeps_updater() {
        // AppImage is the one Linux bundle Tauri can self-update.
        assert!(!compute_updater_disabled(false, true, false, true));
    }

    #[test]
    fn non_linux_desktop_keeps_updater_without_opt_out() {
        // macOS / Windows: the flatpak/appimage clause must not apply, so the
        // updater stays enabled unless the env opt-out is set.
        assert!(!compute_updater_disabled(false, false, false, false));
    }
}
