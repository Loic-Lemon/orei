#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{io::Write, sync::{Mutex, OnceLock}, time::Instant};
use tauri::Manager;
static START: OnceLock<Instant> = OnceLock::new();
mod atomic_output;
mod clipboard_output;
mod close_state;
mod document_io;
mod icon_io;
mod image_io;
mod menu;
mod markdown_assets;
mod markdown_roots;
mod pair_io;
mod pair_locations;

#[tauri::command]
async fn open_document(app: tauri::AppHandle) -> Result<Option<(String, String)>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let Some(selected) = app.dialog().file().add_filter("Markdown document", &["md"]).blocking_pick_file() else { return Ok(None) };
        let path = selected.into_path().map_err(|e| e.to_string())?;
        let name = path.file_name().and_then(|name| name.to_str()).ok_or("Invalid document name")?.to_owned();
        let text = document_io::read(&path)?;
        Ok(Some((name, text)))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn import_icon_file(app: tauri::AppHandle) -> Result<Option<icon_io::PickedIcon>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let Some(selected) = app.dialog().file().add_filter("SVG icon", &["svg"]).blocking_pick_file() else { return Ok(None) };
        let path = selected.into_path().map_err(|e| e.to_string())?;
        let name = path.file_name().and_then(|name| name.to_str()).ok_or("Invalid icon name")?.to_owned();
        let text = icon_io::read(&path)?;
        Ok(Some(icon_io::PickedIcon { name, text }))
    }).await.map_err(|e| e.to_string())?
}

/// Reads a user-picked PNG as a bounded data URL for the active document. The webview
/// receives no filesystem path and the original file is never modified.
#[tauri::command]
async fn import_image_file(app: tauri::AppHandle) -> Result<Option<image_io::PickedImage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let Some(selected) = app.dialog().file().add_filter("PNG image", &["png"]).blocking_pick_file() else { return Ok(None) };
        let path = selected.into_path().map_err(|e| e.to_string())?;
        image_io::read(&path).map(Some)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn import_icon_collection_file(app: tauri::AppHandle) -> Result<Option<icon_io::PickedIcon>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let Some(selected) = app.dialog().file().add_filter("Iconify collection", &["json"]).blocking_pick_file() else { return Ok(None) };
        let path = selected.into_path().map_err(|e| e.to_string())?;
        let name = path.file_name().and_then(|name| name.to_str()).ok_or("Invalid collection name")?.to_owned();
        let text = icon_io::read_collection(&path)?;
        Ok(Some(icon_io::PickedIcon { name, text }))
    }).await.map_err(|e| e.to_string())?
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct MarkdownPreferences {
    default_notes_folder: Option<String>,
    default_attachments_folder: Option<String>,
}

fn preferences_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("preferences.json"))
}

fn roots_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("attachment-roots.json"))
}

/// Reads and writes of approval memory are best-effort: a full disk must never make a note
/// unsavable, and a missing entry only costs one folder confirmation.
fn recall_root(app: &tauri::AppHandle, note: &std::path::Path) -> Option<std::path::PathBuf> {
    markdown_roots::recall(&roots_path(app)?, note)
}

fn remember_root(app: &tauri::AppHandle, note: &std::path::Path, root: &std::path::Path) {
    if let Some(path) = roots_path(app) { let _ = markdown_roots::remember(&path, note, root); }
}

fn refresh_root(app: &tauri::AppHandle, note: &std::path::Path) {
    if let Some(path) = roots_path(app) { let _ = markdown_roots::refresh(&path, note); }
}

#[tauri::command]
fn get_markdown_preferences(app: tauri::AppHandle) -> Result<MarkdownPreferences, String> {
    let path = preferences_path(&app)?;
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(MarkdownPreferences::default()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn set_markdown_preferences(app: tauri::AppHandle, preferences: MarkdownPreferences) -> Result<(), String> {
    let path = preferences_path(&app)?;
    let parent = path.parent().ok_or("Invalid preferences path")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec(&preferences).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(temporary, path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        app.dialog().file().blocking_pick_folder().map(|folder| folder.into_path().map(|path| path.to_string_lossy().into_owned()).map_err(|e| e.to_string())).transpose()
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn prepare_markdown_destination(app: tauri::AppHandle, assets: tauri::State<'_, Mutex<markdown_assets::Registry>>, default_name: String, needs_attachments: bool, override_attachments: bool) -> Result<Option<markdown_assets::PreparedDestination>, String> {
    use tauri_plugin_dialog::DialogExt;
    let preferences = get_markdown_preferences(app.clone())?;
    let suggested = dialog_name(&default_name, "md", "Untitled");
    let selected = tauri::async_runtime::spawn_blocking(move || -> Result<Option<(std::path::PathBuf, std::path::PathBuf)>, String> {
        let mut picker = app.dialog().file().add_filter("Markdown document", &["md"]).set_file_name(&suggested);
        if let Some(folder) = preferences.default_notes_folder.as_deref().filter(|folder| std::path::Path::new(folder).is_dir()) {
            picker = picker.set_directory(folder);
        }
        let Some(selected) = picker.blocking_save_file() else { return Ok(None) };
        let note = selected.into_path().map_err(|error| error.to_string())?;
        let default_root = preferences.default_attachments_folder.as_deref().filter(|folder| std::path::Path::new(folder).is_dir()).map(std::path::PathBuf::from);
        let root = if !needs_attachments {
            default_root.unwrap_or_else(|| note.parent().unwrap_or(std::path::Path::new(".")).to_owned())
        } else if !override_attachments {
            if let Some(root) = default_root { root } else {
                let mut folder_picker = app.dialog().file();
                if let Some(parent) = note.parent() { folder_picker = folder_picker.set_directory(parent); }
                let Some(folder) = folder_picker.blocking_pick_folder() else { return Ok(None) };
                folder.into_path().map_err(|error| error.to_string())?
            }
        } else {
            let mut folder_picker = app.dialog().file();
            if let Some(folder) = default_root.as_deref() { folder_picker = folder_picker.set_directory(folder); }
            else if let Some(parent) = note.parent() { folder_picker = folder_picker.set_directory(parent); }
            let Some(folder) = folder_picker.blocking_pick_folder() else { return Ok(None) };
            folder.into_path().map_err(|error| error.to_string())?
        };
        Ok(Some((note, root)))
    }).await.map_err(|error| error.to_string())??;
    let Some((note, root)) = selected else { return Ok(None) };
    assets.lock().map_err(|error| error.to_string())?.prepare(&note, &root).map(Some)
}

#[tauri::command]
async fn choose_markdown_attachments(app: tauri::AppHandle, assets: tauri::State<'_, Mutex<markdown_assets::Registry>>, registry: tauri::State<'_, Mutex<document_io::Registry>>, handle: String, override_attachments: bool) -> Result<Option<String>, String> {
    if !override_attachments && assets.lock().map_err(|error| error.to_string())?.root(&handle).is_some() {
        return Ok(None);
    }
    let note = registry.lock().map_err(|error| error.to_string())?.path(&handle)?;
    let picker_note = note.clone();
    let remembered = recall_root(&app, &note);
    let preferences = get_markdown_preferences(app.clone())?;
    let dialog_app = app.clone();
    let root = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let mut picker = dialog_app.dialog().file();
        if let Some(folder) = remembered {
            picker = picker.set_directory(folder);
        } else if let Some(folder) = preferences.default_attachments_folder.as_deref().filter(|folder| std::path::Path::new(folder).is_dir()) {
            picker = picker.set_directory(folder);
        } else if let Some(parent) = picker_note.parent() { picker = picker.set_directory(parent); }
        picker.blocking_pick_folder().map(|folder| folder.into_path().map_err(|error| error.to_string())).transpose()
    }).await.map_err(|error| error.to_string())??;
    let Some(root) = root else { return Ok(None) };
    let parent = note.parent().ok_or("Invalid document location")?;
    let relative = markdown_assets::relative_attachment_path(parent, &root)?;
    assets.lock().map_err(|error| error.to_string())?.set_root(&handle, &root)?;
    remember_root(&app, &note, &root);
    Ok(Some(relative))
}

#[tauri::command]
fn cancel_markdown_destination(assets: tauri::State<'_, Mutex<markdown_assets::Registry>>, destination: String) -> Result<bool, String> {
    Ok(assets.lock().map_err(|error| error.to_string())?.cancel_destination(&destination))
}

#[tauri::command]
fn create_markdown_document(app: tauri::AppHandle, assets: tauri::State<'_, Mutex<markdown_assets::Registry>>, registry: tauri::State<'_, Mutex<document_io::Registry>>, destination: String, text: String, files: Vec<markdown_assets::AssetFile>) -> Result<document_io::OpenDocument, String> {
    let mut assets = assets.lock().map_err(|error| error.to_string())?;
    let (path, root) = assets.destination(&destination)?;
    document_io::check_new_destination(&path, &text)?;
    if !files.is_empty() { markdown_assets::publish(&root, &files)?; }
    let mut registry = registry.lock().map_err(|error| error.to_string())?;
    let opened = document_io::create_and_authorize(&mut registry, &path, &text)?;
    assets.finish_destination(&destination, Some(&opened.handle))?;
    drop(assets);
    remember_root(&app, &path, &root);
    Ok(opened)
}

#[tauri::command]
fn save_markdown_copy(app: tauri::AppHandle, assets: tauri::State<'_, Mutex<markdown_assets::Registry>>, destination: String, text: String, files: Vec<markdown_assets::AssetFile>) -> Result<bool, String> {
    let mut assets = assets.lock().map_err(|error| error.to_string())?;
    let (path, root) = assets.destination(&destination)?;
    document_io::check_new_destination(&path, &text)?;
    if !files.is_empty() { markdown_assets::publish(&root, &files)?; }
    document_io::create_copy(&path, &text)?;
    assets.finish_destination(&destination, None)?;
    drop(assets);
    remember_root(&app, &path, &root);
    Ok(true)
}

#[tauri::command]
fn write_markdown_document(app: tauri::AppHandle, assets: tauri::State<'_, Mutex<markdown_assets::Registry>>, registry: tauri::State<'_, Mutex<document_io::Registry>>, handle: String, revision: u64, text: String, files: Vec<markdown_assets::AssetFile>) -> Result<markdown_assets::MarkdownWrite, String> {
    let assets = assets.lock().map_err(|error| error.to_string())?;
    let mut registry = registry.lock().map_err(|error| error.to_string())?;
    let note = registry.path(&handle)?;
    let write = if !files.is_empty() {
        let root = assets.root(&handle).ok_or("Choose an attachments folder in the native Markdown destination flow first")?;
        registry.check_write(&handle, revision, &text)?;
        let published = markdown_assets::publish(&root, &files)?;
        let revision = registry.write(&handle, revision, &text)?;
        markdown_assets::MarkdownWrite { revision, published }
    } else {
        let revision = registry.write(&handle, revision, &text)?;
        markdown_assets::MarkdownWrite { revision, published: Vec::new() }
    };
    refresh_root(&app, &note);
    Ok(write)
}

#[tauri::command]
fn overwrite_markdown_document(app: tauri::AppHandle, assets: tauri::State<'_, Mutex<markdown_assets::Registry>>, registry: tauri::State<'_, Mutex<document_io::Registry>>, handle: String, text: String, shown: Option<String>, files: Vec<markdown_assets::AssetFile>) -> Result<serde_json::Value, String> {
    let assets = assets.lock().map_err(|error| error.to_string())?;
    let mut registry = registry.lock().map_err(|error| error.to_string())?;
    let note = registry.path(&handle)?;
    registry.check_overwrite(&handle, &text)?;
    let published = if files.is_empty() { Vec::new() } else {
        let root = assets.root(&handle).ok_or("Choose an attachments folder in the native Markdown destination flow first")?;
        markdown_assets::publish(&root, &files)?
    };
    let outcome = registry.overwrite(&handle, &text, shown.as_deref())?;
    refresh_root(&app, &note);
    let mut value = serde_json::to_value(outcome).map_err(|error| error.to_string())?;
    value["published"] = serde_json::to_value(published).map_err(|error| error.to_string())?;
    Ok(value)
}

#[tauri::command]
async fn read_markdown_assets(app: tauri::AppHandle, assets: tauri::State<'_, Mutex<markdown_assets::Registry>>, registry: tauri::State<'_, Mutex<document_io::Registry>>, handle: String, references: Vec<markdown_assets::AssetReference>, allow_prompt: bool) -> Result<Option<Vec<markdown_assets::ResolvedAsset>>, String> {
    if references.is_empty() { return Ok(Some(Vec::new())); }
    let note = registry.lock().map_err(|error| error.to_string())?.path(&handle)?;
    // A live root is an approval from this process. A remembered root is only permission to
    // read: it is never installed as a write root, so a stale entry cannot redirect a save.
    let live = assets.lock().map_err(|error| error.to_string())?.root(&handle);
    let mut root = live.or_else(|| recall_root(&app, &note));
    let authorized = match root.as_deref() {
        Some(root) => markdown_assets::references_within_root(&note, root, &references)?,
        None => false,
    };
    if !authorized {
        if !allow_prompt {
            // Background inspection never opens a native picker. A named error keeps the
            // existing conflict path in the app instead of a modal dialog.
            return Err("The attachments folder for this note is not known on this machine. Open the note again to choose it.".into());
        }
        let suggestion = root.clone().or_else(|| note.parent().map(std::path::Path::to_path_buf));
        let dialog_app = app.clone();
        let selected = tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_dialog::DialogExt;
            let mut picker = dialog_app.dialog().file();
            if let Some(folder) = suggestion { picker = picker.set_directory(folder); }
            picker.blocking_pick_folder()
                .map(|folder| folder.into_path().map_err(|error| error.to_string())).transpose()
        }).await.map_err(|error| error.to_string())??;
        let Some(selected) = selected else { return Ok(None) };
        assets.lock().map_err(|error| error.to_string())?.set_root(&handle, &selected)?;
        remember_root(&app, &note, &selected);
        root = Some(selected);
    }
    let root = root.ok_or("Attachment folder is not authorized")?;
    markdown_assets::read_authorized(&note, &root, &references).map(Some)
}

#[tauri::command]
fn markdown_root_ready(assets: tauri::State<'_, Mutex<markdown_assets::Registry>>, handle: String) -> Result<bool, String> {
    Ok(assets.lock().map_err(|error| error.to_string())?.root(&handle).is_some())
}

fn pair_locations_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|path| path.join("paired-locations.json"))
}

#[tauri::command]
fn restore_paired_document(app: tauri::AppHandle, pairs: tauri::State<'_, Mutex<pair_io::PairRegistry>>, location_id: String) -> Result<Option<pair_io::OpenPair>, String> {
    let mut pairs = pairs.lock().map_err(|e| e.to_string())?;
    let Some(path) = pair_locations_path(&app).and_then(|store| pair_locations::recall(&store, &location_id)) else { return Ok(None) };
    let mut opened = pairs.authorize(path)?;
    opened.location_id = Some(location_id);
    Ok(Some(opened))
}

#[tauri::command]
async fn open_named_document(app: tauri::AppHandle, registry: tauri::State<'_, Mutex<document_io::Registry>>, pairs: tauri::State<'_, Mutex<pair_io::PairRegistry>>, markdown: tauri::State<'_, Mutex<markdown_assets::Registry>>, paired_name: Option<String>) -> Result<Option<serde_json::Value>, String> {
    let store = pair_locations_path(&app);
    let paired_only = paired_name.is_some();
    let Some(path) = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let picker = app.dialog().file();
        let picker = match paired_name {
            Some(name) => picker.set_title("Choose the original Mermaid file")
                .set_file_name(dialog_name(&name, "mmd", "Diagram"))
                .add_filter("Mermaid diagram", &["mmd"]),
            None => picker.add_filter("Diagram document", &["md", "mmd"]),
        };
        picker.blocking_pick_file()
            .map(|selected| selected.into_path().map_err(|e| e.to_string()))
    }).await.map_err(|e| e.to_string())? else { return Ok(None) };
    let path = path?;
    let extension = path.extension().and_then(|value| value.to_str()).map(|value| value.to_ascii_lowercase());
    match extension.as_deref() {
        Some("mmd") => {
            let mut pairs = pairs.lock().map_err(|e| e.to_string())?;
            let mut opened = pairs.authorize(path.clone())?;
            opened.location_id = store.and_then(|store| pair_locations::remember(&store, &path, &opened.handle));
            serde_json::to_value(opened).map(Some).map_err(|e| e.to_string())
        }
        Some("md") if !paired_only => {
            let opened = registry.lock().map_err(|e| e.to_string())?.authorize(path)?;
            markdown.lock().map_err(|e| e.to_string())?.authorize_open(&opened.handle);
            serde_json::to_value(opened).map(Some).map_err(|e| e.to_string())
        }
        _ if paired_only => Err("Choose the original .mmd file to reconnect this tab.".into()),
        _ => Err("Expected a .md or .mmd document".into()),
    }
}

#[tauri::command]
fn write_paired_document(registry: tauri::State<'_, Mutex<pair_io::PairRegistry>>, handle: String, expected: pair_io::PairRevisions, source: String, css: Option<String>, assets: Option<String>) -> Result<pair_io::WriteOutcome, String> {
    registry.lock().map_err(|e| e.to_string())?.write(&handle, &expected, &source, css.as_deref(), assets.as_deref())
}

#[tauri::command]
fn read_paired_asset(registry: tauri::State<'_, Mutex<pair_io::PairRegistry>>, handle: String, reference: String) -> Result<String, String> {
    registry.lock().map_err(|e| e.to_string())?.read_asset(&handle, &reference)
}

#[tauri::command]
fn write_named_document(registry: tauri::State<'_, Mutex<document_io::Registry>>, handle: String, revision: u64, text: String) -> Result<u64, String> {
    registry.lock().map_err(|e| e.to_string())?.write(&handle, revision, &text)
}

#[tauri::command]
fn inspect_named_document(registry: tauri::State<'_, Mutex<document_io::Registry>>, handle: String) -> Result<document_io::DocumentState, String> {
    registry.lock().map_err(|e| e.to_string())?.inspect(&handle)
}

#[tauri::command]
fn reload_named_document(registry: tauri::State<'_, Mutex<document_io::Registry>>, handle: String) -> Result<document_io::OpenDocument, String> {
    registry.lock().map_err(|e| e.to_string())?.reload(&handle)
}

#[tauri::command]
fn overwrite_named_document(registry: tauri::State<'_, Mutex<document_io::Registry>>, handle: String, text: String, shown: Option<String>) -> Result<document_io::OverwriteOutcome, String> {
    registry.lock().map_err(|e| e.to_string())?.overwrite(&handle, &text, shown.as_deref())
}

#[tauri::command]
fn release_named_document(registry: tauri::State<'_, Mutex<document_io::Registry>>, markdown: tauri::State<'_, Mutex<markdown_assets::Registry>>, handle: String) -> Result<bool, String> {
    let released = registry.lock().map_err(|e| e.to_string())?.release(&handle);
    markdown.lock().map_err(|e| e.to_string())?.forget(&handle);
    Ok(released)
}

#[tauri::command]
fn inspect_paired_document(registry: tauri::State<'_, Mutex<pair_io::PairRegistry>>, handle: String) -> Result<pair_io::PairState, String> {
    registry.lock().map_err(|e| e.to_string())?.inspect(&handle)
}

#[tauri::command]
fn reload_paired_document(registry: tauri::State<'_, Mutex<pair_io::PairRegistry>>, handle: String) -> Result<pair_io::OpenPair, String> {
    registry.lock().map_err(|e| e.to_string())?.reload(&handle)
}

#[tauri::command]
fn overwrite_paired_document(registry: tauri::State<'_, Mutex<pair_io::PairRegistry>>, handle: String, source: String, css: Option<String>, assets: Option<String>, shown: Option<pair_io::ShownGroup>) -> Result<pair_io::WriteOutcome, String> {
    registry.lock().map_err(|e| e.to_string())?.overwrite(&handle, &source, css.as_deref(), assets.as_deref(), shown.as_ref())
}

#[tauri::command]
fn release_paired_document(registry: tauri::State<'_, Mutex<pair_io::PairRegistry>>, handle: String) -> Result<bool, String> {
    Ok(registry.lock().map_err(|e| e.to_string())?.release(&handle))
}

#[tauri::command]
async fn create_named_document(app: tauri::AppHandle, registry: tauri::State<'_, Mutex<document_io::Registry>>, text: String, default_name: String) -> Result<Option<document_io::OpenDocument>, String> {
    let suggested = dialog_name(&default_name, "md", "Untitled");
    let Some(path) = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        app.dialog().file().add_filter("Markdown document", &["md"]).set_file_name(&suggested).blocking_save_file()
            .map(|selected| selected.into_path().map_err(|e| e.to_string()))
    }).await.map_err(|e| e.to_string())? else { return Ok(None) };
    let path = path?;
    let mut registry = registry.lock().map_err(|e| e.to_string())?;
    document_io::create_and_authorize(&mut registry, &path, &text).map(Some)
}

#[tauri::command]
async fn create_paired_destination(app: tauri::AppHandle, pairs: tauri::State<'_, Mutex<pair_io::PairRegistry>>, source: String, css: String, assets: Option<String>, default_name: String) -> Result<Option<pair_io::OpenPair>, String> {
    let suggested = dialog_name(&default_name, "mmd", "Untitled");
    let store = pair_locations_path(&app);
    let Some(path) = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        app.dialog().file().add_filter("Mermaid diagram", &["mmd"]).set_file_name(&suggested).blocking_save_file()
            .map(|selected| selected.into_path().map_err(|e| e.to_string()))
    }).await.map_err(|e| e.to_string())? else { return Ok(None) };
    let path = path?;
    let mut pairs = pairs.lock().map_err(|e| e.to_string())?;
    let mut opened = pairs.create(path.clone(), &source, &css, assets.as_deref())?;
    opened.location_id = store.and_then(|store| pair_locations::remember(&store, &path, &opened.handle));
    Ok(Some(opened))
}

#[tauri::command]
async fn save_document_copy(app: tauri::AppHandle, text: String, default_name: String) -> Result<bool, String> {
    let suggested = dialog_name(&default_name, "md", "Untitled");
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let Some(selected) = app.dialog().file().add_filter("Markdown document", &["md"]).set_file_name(&suggested).blocking_save_file() else { return Ok(false) };
        let path = selected.into_path().map_err(|e| e.to_string())?;
        document_io::create_copy(&path, &text)?;
        Ok(true)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_paired_copy(app: tauri::AppHandle, pairs: tauri::State<'_, Mutex<pair_io::PairRegistry>>, source: String, css: String, assets: Option<String>, default_name: String) -> Result<bool, String> {
    let suggested = dialog_name(&default_name, "mmd", "Untitled");
    let Some(path) = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        app.dialog().file().add_filter("Mermaid diagram", &["mmd"]).set_file_name(&suggested).blocking_save_file()
            .map(|selected| selected.into_path().map_err(|e| e.to_string()))
    }).await.map_err(|e| e.to_string())? else { return Ok(false) };
    let path = path?;
    let pairs = pairs.lock().map_err(|e| e.to_string())?;
    pairs.create_copy(path, &source, &css, assets.as_deref())?;
    Ok(true)
}

/// Suggests a plain basename with the destination's extension; the native picker owns the
/// selected directory, so a webview-supplied path is never used as the destination.
fn dialog_name(requested: &str, extension: &str, fallback: &str) -> String {
    let basename = std::path::Path::new(requested).file_name().and_then(|name| name.to_str()).unwrap_or("");
    let stem = std::path::Path::new(basename).file_stem().and_then(|stem| stem.to_str()).filter(|stem| !stem.is_empty()).unwrap_or(fallback);
    format!("{stem}.{extension}")
}

#[tauri::command]
fn close_listener_ready(state: tauri::State<'_, Mutex<close_state::CloseState>>) -> bool {
    state.lock().unwrap().ready()
}

#[tauri::command]
fn exit_after_recovery(app: tauri::AppHandle, state: tauri::State<'_, Mutex<close_state::CloseState>>) -> Result<(), String> {
    state.lock().unwrap().approve()?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn cancel_close(state: tauri::State<'_, Mutex<close_state::CloseState>>) {
    state.lock().unwrap().cancel();
}

#[tauri::command]
fn evidence_context() -> serde_json::Value {
    serde_json::json!({"scenario":std::env::var("OREI_SCENARIO").ok(),"run":std::env::var("OREI_RUN").ok()})
}
#[tauri::command]
fn evidence_event(event: serde_json::Value) -> Result<(), String> {
    if let Ok(dir) = std::env::var("OREI_EVIDENCE_DIR") {
        let mut file=std::fs::OpenOptions::new().create(true).append(true).open(std::path::Path::new(&dir).join("events.jsonl")).map_err(|e|e.to_string())?;
        writeln!(file,"{}",serde_json::json!({"native_ms":START.get().unwrap().elapsed().as_secs_f64()*1000.,"event":event})).map_err(|e|e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
fn evidence_artifact(name: String, bytes: Vec<u8>) -> Result<(),String> {
    let dir=std::env::var("OREI_EVIDENCE_DIR").map_err(|_|"Not in evidence mode")?;
    if name.contains('/') || name.contains('\\') || !(name.ends_with(".svg") || name.ends_with(".png")) {return Err("Invalid artifact name".into())}
    std::fs::write(std::path::Path::new(&dir).join(name),bytes).map_err(|e|e.to_string())
}
#[tauri::command]
fn evidence_resize(app:tauri::AppHandle,width:f64)->Result<(),String>{
    if std::env::var("OREI_EVIDENCE_DIR").is_err() || !(720.0..=1600.0).contains(&width) {return Err("Unavailable resize".into())}
    app.get_webview_window("main").unwrap().set_size(tauri::LogicalSize::new(width,820.)).map_err(|e|e.to_string())
}
fn retained_menu_items(app:&tauri::AppHandle)->Result<tauri::State<'_,Mutex<menu::MenuItems>>,String>{
    app.try_state::<Mutex<menu::MenuItems>>().ok_or_else(||"Application menu unavailable".into())
}
#[tauri::command]
fn set_export_enabled(app:tauri::AppHandle,enabled:bool)->Result<(),String>{
    let items=retained_menu_items(&app)?;
    let items=items.lock().map_err(|e|e.to_string())?;
    items.set_enabled("export",enabled)
}
#[tauri::command]
fn set_edit_enabled(app:tauri::AppHandle,undo:bool,redo:bool)->Result<(),String>{
    let items=retained_menu_items(&app)?;
    let items=items.lock().map_err(|e|e.to_string())?;
    for (id,enabled) in [("undo",undo),("redo",redo)] {
        items.set_enabled(id,enabled)?;
    }
    Ok(())
}
#[tauri::command]
fn save_output(path:String, bytes:Vec<u8>) -> Result<(),String> {
    if bytes.len()>128*1024*1024 || !(path.ends_with(".svg") || path.ends_with(".png")) {return Err("Unsupported output".into())}
    atomic_output::replace_output(std::path::Path::new(&path), |file| file.write_all(&bytes)).map_err(|e|e.to_string())
}

/// Copies a rendered PNG to the system pasteboard. The payload is the same `png()` bytes
/// the file export writes; a clipboard failure is reported instead of claiming success.
#[tauri::command]
async fn copy_output_image(app: tauri::AppHandle, bytes: Vec<u8>) -> Result<(), String> {
    let image = clipboard_output::decode_image(&bytes)?;
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        app.clipboard().write_image(&tauri::image::Image::new_owned(image.rgba, image.width, image.height)).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

/// Copies standalone SVG markup or the current Mermaid source as plain text.
#[tauri::command]
async fn copy_output_text(app: tauri::AppHandle, text: String) -> Result<(), String> {
    clipboard_output::validate_text(&text)?;
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        app.clipboard().write_text(text).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

/// Keeps the diagram-output copy menu items in step with the export availability; the
/// Mermaid source item stays enabled while rendering is invalid.
#[tauri::command]
fn set_copy_enabled(app:tauri::AppHandle,enabled:bool)->Result<(),String>{
    let items=retained_menu_items(&app)?;
    let items=items.lock().map_err(|e|e.to_string())?;
    for id in ["copy-image","copy-svg"] {
        items.set_enabled(id,enabled)?;
    }
    // Source copying never needs a valid render, so it is not part of the export gate.
    items.set_enabled("copy-source",true)
}

fn main() {
    START.set(Instant::now()).ok();
    let _ = evidence_event(serde_json::json!({"type":"boundary","name":"native-main"}));
    tauri::Builder::default().manage(Mutex::new(close_state::CloseState::default())).manage(Mutex::new(document_io::Registry::default())).manage(Mutex::new(pair_io::PairRegistry::default())).manage(Mutex::new(markdown_assets::Registry::default())).plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![evidence_context,evidence_event,evidence_artifact,evidence_resize,set_export_enabled,set_edit_enabled,get_markdown_preferences,set_markdown_preferences,pick_folder,prepare_markdown_destination,choose_markdown_attachments,cancel_markdown_destination,create_markdown_document,save_markdown_copy,write_markdown_document,overwrite_markdown_document,read_markdown_assets,markdown_root_ready,save_output,copy_output_image,copy_output_text,set_copy_enabled,open_document,save_document_copy,save_paired_copy,open_named_document,restore_paired_document,create_named_document,create_paired_destination,write_named_document,write_paired_document,inspect_named_document,reload_named_document,overwrite_named_document,release_named_document,inspect_paired_document,reload_paired_document,overwrite_paired_document,release_paired_document,read_paired_asset,import_icon_file,import_icon_collection_file,import_image_file,close_listener_ready,exit_after_recovery,cancel_close])
        // The app-wide menu is installed before the first window exists, and its items are
        // managed here so the enablement commands can resolve nested File/Edit handles.
        .menu(menu::build)
        .on_menu_event(|app,event|menu::on_menu_event(app,event.id().as_ref()))
        .setup(|app| {
            let _ = evidence_event(serde_json::json!({"type":"boundary","name":"native-setup-start"}));
            // A regular activation policy gives orei a Dock icon and the app-wide menu bar
            // even when launched from a terminal during development.
            #[cfg(target_os="macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);
            // Size variants exercise the actual native window, not a browser viewport.
            if let Ok(width)=std::env::var("OREI_WINDOW_WIDTH") {if let Ok(width)=width.parse::<f64>() {app.get_webview_window("main").unwrap().set_size(tauri::LogicalSize::new(width,820.))?;}}
            let _ = evidence_event(serde_json::json!({"type":"boundary","name":"native-setup-end"}));
            Ok(())
        })
        .on_window_event(|window,event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                use tauri::Emitter;
                api.prevent_close();
                let state = window.state::<Mutex<close_state::CloseState>>();
                let mut state = state.lock().unwrap();
                if state.request() && window.emit("window-close-request", ()).is_err() {
                    state.delivery_failed();
                }
            }
        })
        .build(tauri::generate_context!()).expect("Could not build orei")
        .run(|app,event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                let approved = app.state::<Mutex<close_state::CloseState>>().lock().unwrap().consume_exit(code);
                if !approved {
                    if let Some(window) = app.get_webview_window("main") {
                        api.prevent_exit();
                        let _ = window.close();
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::dialog_name;

    #[test]
    fn window_title_and_bundle_identifier_are_the_release_values() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["app"]["windows"][0]["title"], "orei");
        // Changing this identifier would move the app's existing data directories.
        assert_eq!(config["identifier"], "local.orei.feasibility");
    }

    #[test]
    fn suggested_names_are_plain_basenames_with_the_destination_extension() {
        assert_eq!(dialog_name("note.md", "mmd", "Untitled"), "note.mmd");
        assert_eq!(dialog_name("diagram.mmd", "md", "Untitled"), "diagram.md");
        assert_eq!(dialog_name("Untitled 3", "md", "Untitled"), "Untitled 3.md");
        assert_eq!(dialog_name("../../outside/secret.md", "mmd", "Untitled"), "secret.mmd");
        assert_eq!(dialog_name("", "md", "Untitled"), "Untitled.md");
    }
}
