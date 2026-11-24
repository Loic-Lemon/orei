use std::{collections::{HashMap, HashSet}, fs, io::{Read, Write}, path::{Component, Path, PathBuf}, sync::atomic::{AtomicU64, Ordering}};

static NEXT: AtomicU64 = AtomicU64::new(0);
const ASSET_LIMIT: usize = 2 * 1024 * 1024;
const FILES_LIMIT: usize = 256;

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetFile {
    pub path: String,
    pub data: String,
    pub kind: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedDestination {
    pub destination: String,
    pub attachments: String,
    pub namespace: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetReference {
    pub path: String,
    pub kind: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAsset {
    pub path: String,
    pub data: String,
    pub kind: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownWrite {
    pub revision: u64,
    pub published: Vec<String>,
}

#[derive(Clone)]
struct Destination { note: PathBuf, root: PathBuf }

/// Native-picker approvals are bound to opaque destinations and open-document handles, never
/// to mutable global preferences. A handle's root does not change when Settings change.
#[derive(Default)]
pub struct Registry {
    destinations: HashMap<String, Destination>,
    roots: HashMap<String, PathBuf>,
}

impl Registry {
    pub fn prepare(&mut self, note: &Path, root: &Path) -> Result<PreparedDestination, String> {
        let note = if note.extension().is_none() { note.with_extension("md") } else { note.to_owned() };
        let parent = note.parent().filter(|path| !path.as_os_str().is_empty()).unwrap_or(Path::new("."));
        let parent = fs::canonicalize(parent).map_err(|error| error.to_string())?;
        let name = note.file_name().ok_or("Invalid document name")?;
        if name.to_str().is_none() { return Err("Invalid document name".into()); }
        if !note.extension().and_then(|value| value.to_str()).is_some_and(|value| value.eq_ignore_ascii_case("md")) {
            return Err("Expected a .md document".into());
        }
        let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
        if !root.is_dir() { return Err("Attachment root is not a directory".into()); }
        let attachments = relative_path(&parent, &root)?;
        static NEXT_DESTINATION: AtomicU64 = AtomicU64::new(1);
        let destination = format!("orei-markdown-{}-{}", std::process::id(), NEXT_DESTINATION.fetch_add(1, Ordering::Relaxed));
        // Content-addressed files group under the note stem, so two notes sharing one
        // attachments folder keep their identical-looking attachments apart. The opaque
        // destination remains the registry key only.
        let namespace = storage_segment(note.file_stem().and_then(|value| value.to_str()).unwrap_or_default());
        let namespace = if namespace.is_empty() { destination.clone() } else { namespace };
        self.destinations.insert(destination.clone(), Destination { note: parent.join(name), root });
        Ok(PreparedDestination { destination, attachments, namespace })
    }

    pub fn destination(&self, id: &str) -> Result<(PathBuf, PathBuf), String> {
        self.destinations.get(id).map(|item| (item.note.clone(), item.root.clone())).ok_or_else(|| "Unknown Markdown destination".into())
    }

    pub fn finish_destination(&mut self, id: &str, handle: Option<&str>) -> Result<(), String> {
        let destination = self.destinations.remove(id).ok_or("Unknown Markdown destination")?;
        if let Some(handle) = handle { self.roots.insert(handle.to_owned(), destination.root); }
        Ok(())
    }

    pub fn cancel_destination(&mut self, id: &str) -> bool { self.destinations.remove(id).is_some() }
    pub fn authorize_open(&mut self, handle: &str) { self.roots.remove(handle); }
    pub fn root(&self, handle: &str) -> Option<PathBuf> { self.roots.get(handle).cloned() }
    pub fn set_root(&mut self, handle: &str, root: &Path) -> Result<(), String> {
        let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
        if !root.is_dir() { return Err("Attachment root is not a directory".into()); }
        self.roots.insert(handle.to_owned(), root);
        Ok(())
    }
    pub fn forget(&mut self, handle: &str) { self.roots.remove(handle); }
}

/// Publishes only into a root previously selected/approved by native UI. Files are staged
/// beneath that root, then linked into place; an identical file already at a target counts as
/// published, while different content there is refused instead of replaced.
/// The caller must write the note only after this returns successfully.
pub fn publish(root: &Path, files: &[AssetFile]) -> Result<Vec<String>, String> {
    if files.len() > FILES_LIMIT {
        return Err("Too many Markdown attachments".into());
    }
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("Attachment root is not a directory".into());
    }
    let staging = root.join(format!(
        ".orei-stage-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&staging).map_err(|error| error.to_string())?;
    let result = (|| {
        let mut staged = Vec::with_capacity(files.len());
        for (index, file) in files.iter().enumerate() {
            let relative = safe_relative(&file.path)?;
            if relative.components().any(|part| matches!(part, Component::ParentDir)) {
                return Err("Attachment path escapes its approved root".into());
            }
            let bytes = match file.kind.as_str() {
                "image" => decode_png_data_url(&file.data)?,
                "icon" => {
                    validate_svg(&file.data)?;
                    file.data.as_bytes().to_vec()
                }
                "css" => {
                    if file.data.len() > ASSET_LIMIT {
                        return Err("Stylesheet attachment exceeds the supported size".into());
                    }
                    file.data.as_bytes().to_vec()
                }
                _ => return Err("Unsupported Markdown attachment type".into()),
            };
            if bytes.len() > ASSET_LIMIT {
                return Err("Attachment exceeds the supported size".into());
            }
            let stage_path = staging.join(index.to_string());
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&stage_path)
                .map_err(|error| error.to_string())?;
            output
                .write_all(&bytes)
                .map_err(|error| error.to_string())?;
            output.sync_all().map_err(|error| error.to_string())?;
            staged.push((relative, stage_path, bytes.len(), file.path.clone()));
        }
        let mut targets = Vec::with_capacity(staged.len());
        let mut unique_targets = HashSet::new();
        let mut published = Vec::new();
        for (relative, staged_path, staged_len, original) in staged {
            let destination = root.join(relative);
            reject_symlinks(&root, destination.strip_prefix(&root).map_err(|_| "Attachment path escapes its approved root")?)?;
            let parent = destination
                .parent()
                .ok_or("Invalid attachment destination")?;
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            let resolved_parent = fs::canonicalize(parent).map_err(|error| error.to_string())?;
            if !resolved_parent.starts_with(&root) {
                return Err("Attachment path escapes its approved root".into());
            }
            let target =
                resolved_parent.join(destination.file_name().ok_or("Invalid attachment name")?);
            if !unique_targets.insert(target.clone()) { return Err("Duplicate Markdown attachment path".into()); }
            if target.exists() {
                // Content addressing puts identical bytes at identical paths, so a target that
                // already holds these bytes is published and must not be linked again. The size
                // check keeps a large unrelated file at that path from being read into memory.
                let same = target.is_file()
                    && fs::metadata(&target).map_err(|error| error.to_string())?.len() == staged_len as u64
                    && fs::read(&target).map_err(|error| error.to_string())?
                        == fs::read(&staged_path).map_err(|error| error.to_string())?;
                if same {
                    published.push(original);
                    continue;
                }
                return Err("An attachment with different content already exists at this path; move it before saving.".into());
            }
            targets.push((staged_path, target, original));
        }
        let mut linked: Vec<(PathBuf, PathBuf)> = Vec::new();
        for (staged_path, target, original) in targets {
            if let Err(error) = fs::hard_link(&staged_path, &target) {
                for (staged, destination) in linked { remove_link_if_same(&staged, &destination); }
                return Err(if error.kind() == std::io::ErrorKind::AlreadyExists {
                    "An attachment with different content already exists at this path; move it before saving.".to_owned()
                } else if error.raw_os_error() == Some(13) {
                    format!("Cannot write attachments into this folder: permission denied. Choose a writable attachments folder. ({error})")
                } else {
                    format!("Cannot link attachments into this folder. It may be read-only, or the filesystem may not support hard links, as exFAT, FAT32, and some network shares do not. Choose a different attachments folder. ({error})")
                });
            }
            linked.push((staged_path, target));
            published.push(original);
        }
        Ok(published)
    })();
    let _ = fs::remove_dir_all(staging);
    result
}

/// Keeps a note stem usable as one path segment; the renderer mirrors this class when it
/// plans content-addressed paths.
fn storage_segment(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn safe_relative(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.len() > 4096 || value.contains(['\\', '\0', '\r', '\n'])
        || value.split('/').any(|part| part.is_empty() || part == ".") {
        return Err("Invalid Markdown attachment path".into());
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::RootDir | Component::Prefix(_)))
    {
        return Err("Invalid Markdown attachment path".into());
    }
    // Parent components are valid for a note-relative path, but canonical resolution must
    // remain inside the separately approved attachment root.
    if path
        .components()
        .any(|part| matches!(part, Component::CurDir))
    {
        return Err("Invalid Markdown attachment path".into());
    }
    Ok(path.to_owned())
}

fn validate_svg(value: &str) -> Result<(), String> {
    let svg = value.to_ascii_lowercase();
    if value.len() > 100_000 || !svg.trim_start().starts_with('<')
        || ["<!", "<?", "<script", "<style", "<foreignobject", "<image", "<a ", " onload", " onclick", " href=", " src=", "javascript:", "file:", "data:", "url("].iter().any(|token| svg.contains(token)) {
        return Err("Unsupported or active SVG attachment".into());
    }
    Ok(())
}

fn relative_path(from: &Path, to: &Path) -> Result<String, String> {
    let left: Vec<_> = from.components().collect();
    let right: Vec<_> = to.components().collect();
    let common = left.iter().zip(&right).take_while(|(a, b)| a == b).count();
    if common == 0 { return Err("Could not express attachment folder relative to the note".into()); }
    let mut parts = vec!["..".to_owned(); left.len() - common];
    for part in &right[common..] {
        if let Component::Normal(value) = part {
            parts.push(value.to_str().ok_or("Attachment folder name is not valid Unicode")?.to_owned());
        }
    }
    if parts.is_empty() { Ok(".".into()) } else { Ok(parts.join("/")) }
}

pub fn relative_attachment_path(note_parent: &Path, root: &Path) -> Result<String, String> {
    let parent = fs::canonicalize(note_parent).map_err(|error| error.to_string())?;
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    relative_path(&parent, &root)
}

fn reject_symlinks(root: &Path, relative: &Path) -> Result<(), String> {
    let mut current = root.to_owned();
    for component in relative.components() {
        match component {
            Component::Normal(part) => current.push(part),
            Component::ParentDir => current.push(".."),
            Component::CurDir => continue,
            _ => return Err("Invalid Markdown attachment path".into()),
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => return Err("Attachment path contains a symbolic link".into()),
            Ok(_) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

pub fn read_authorized(note: &Path, root: &Path, references: &[AssetReference]) -> Result<Vec<ResolvedAsset>, String> {
    if references.len() > FILES_LIMIT { return Err("Too many Markdown attachments".into()); }
    let note_parent = fs::canonicalize(note.parent().ok_or("Invalid document location")?).map_err(|error| error.to_string())?;
    let root = fs::canonicalize(root).map_err(|_| format!("Attachments folder not found: {}", root.display()))?;
    if !root.is_dir() { return Err(format!("Attachments folder not found: {}", root.display())); }
    let mut output = Vec::with_capacity(references.len());
    for reference in references {
        let relative = safe_relative(&reference.path)?;
        let candidate = note_parent.join(&relative);
        reject_symlinks(&note_parent, &relative)?;
        // A reference that cannot be resolved is missing, not unauthorized: naming it here
        // keeps the caller from offering a folder picker that cannot repair the note.
        let path = fs::canonicalize(&candidate).map_err(|error| if error.kind() == std::io::ErrorKind::NotFound {
            format!("Missing attachment: {}", reference.path)
        } else {
            format!("Could not read attachment {}: {error}", reference.path)
        })?;
        if !path.starts_with(&root) { return Err("Attachment path escapes its approved root".into()); }
        let metadata = fs::symlink_metadata(&candidate).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() { return Err("Expected a regular attachment file".into()); }
        let mut bytes = Vec::new();
        fs::File::open(&path).map_err(|error| error.to_string())?.take((ASSET_LIMIT + 1) as u64).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
        if bytes.len() > ASSET_LIMIT { return Err("Attachment exceeds the supported size".into()); }
        let data = match reference.kind.as_str() {
            "image" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => format!("data:image/png;base64,{}", encode_base64(&bytes)),
            "image" => return Err("Invalid PNG attachment".into()),
            "icon" | "css" => {
                let text = String::from_utf8(bytes).map_err(|_| "Attachment is not UTF-8")?;
                if reference.kind == "icon" { validate_svg(&text)?; }
                text
            }
            _ => return Err("Unsupported Markdown attachment type".into()),
        };
        output.push(ResolvedAsset { path: reference.path.clone(), data, kind: reference.kind.clone() });
    }
    Ok(output)
}

fn remove_link_if_same(staged: &Path, destination: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let (Ok(source), Ok(target)) = (fs::metadata(staged), fs::symlink_metadata(destination)) {
            if source.dev() == target.dev() && source.ino() == target.ino() { let _ = fs::remove_file(destination); }
        }
    }
    #[cfg(not(unix))]
    let _ = (staged, destination);
}

pub fn references_within_root(note: &Path, root: &Path, references: &[AssetReference]) -> Result<bool, String> {
    let parent = fs::canonicalize(note.parent().ok_or("Invalid document location")?).map_err(|error| error.to_string())?;
    let root = fs::canonicalize(root).map_err(|_| format!("Attachments folder not found: {}", root.display()))?;
    for reference in references {
        let relative = safe_relative(&reference.path)?;
        reject_symlinks(&parent, &relative)?;
        let candidate = match fs::canonicalize(parent.join(relative)) {
            Ok(candidate) => candidate,
            // Missing is not escaping. Reporting it as authorized lets the reader name the
            // missing attachment instead of disguising it as a folder approval problem.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Could not resolve attachment {}: {error}", reference.path)),
        };
        if !candidate.starts_with(&root) { return Ok(false); }
    }
    Ok(true)
}

fn encode_base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let value = ((chunk[0] as u32) << 16)
            | ((chunk.get(1).copied().unwrap_or(0) as u32) << 8)
            | chunk.get(2).copied().unwrap_or(0) as u32;
        output.push(TABLE[((value >> 18) & 63) as usize] as char);
        output.push(TABLE[((value >> 12) & 63) as usize] as char);
        output.push(if chunk.len() > 1 { TABLE[((value >> 6) & 63) as usize] as char } else { '=' });
        output.push(if chunk.len() > 2 { TABLE[(value & 63) as usize] as char } else { '=' });
    }
    output
}

fn decode_png_data_url(value: &str) -> Result<Vec<u8>, String> {
    let encoded = value
        .strip_prefix("data:image/png;base64,")
        .ok_or("Invalid PNG attachment")?;
    if encoded.len() > 2_000_000 {
        return Err("Attachment exceeds the supported size".into());
    }
    let bytes = decode_base64(encoded)?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("Invalid PNG attachment".into());
    }
    Ok(bytes)
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut accumulator = 0u32;
    let mut bits = 0;
    for byte in input.bytes() {
        if byte == b'=' {
            break;
        }
        let value = TABLE
            .iter()
            .position(|candidate| *candidate == byte)
            .ok_or("Invalid PNG attachment")? as u32;
        accumulator = (accumulator << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((accumulator >> bits) as u8);
        }
    }
    if input.len() % 4 != 0 {
        return Err("Invalid PNG attachment".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    static DIR: AtomicU64 = AtomicU64::new(0);

    fn temp() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "orei-markdown-assets-{}-{}",
            std::process::id(),
            DIR.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn publishes_png_and_svg_and_skips_an_identical_republish() {
        let root = temp();
        let files = vec![
            AssetFile {
                path: "note/v1/image.png".into(),
                data: "data:image/png;base64,iVBORw0KGgo=".into(),
                kind: "image".into(),
            },
            AssetFile {
                path: "note/v1/icon.svg".into(),
                data: "<svg/>".into(),
                kind: "icon".into(),
            },
        ];
        assert_eq!(publish(&root, &files).unwrap().len(), 2);
        let image = root.join("note/v1/image.png");
        let old = fs::read(&image).unwrap();
        // Content addressing makes identical bytes at one path an already-published file, so a
        // repeat save must succeed, keep the existing bytes, and still report both attachments.
        assert_eq!(publish(&root, &files).unwrap().len(), 2);
        assert_eq!(fs::read(image).unwrap(), old);
        assert_eq!(
            fs::read_dir(&root)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".orei-stage-"))
                .count(),
            0
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_different_content_that_would_replace_an_existing_attachment() {
        let root = temp();
        let file = |data: &str| AssetFile {
            path: "note/a/image.png".into(),
            data: data.into(),
            kind: "image".into(),
        };
        publish(&root, &[file("data:image/png;base64,iVBORw0KGgo=")]).unwrap();
        let existing = fs::read(root.join("note/a/image.png")).unwrap();
        // Different bytes at a content-addressed path means the note and its files disagree;
        // replacing the file silently would break every earlier note that still refers to it.
        assert_eq!(
            publish(&root, &[file("data:image/png;base64,iVBORw0KGgpB")]).unwrap_err(),
            "An attachment with different content already exists at this path; move it before saving."
        );
        assert_eq!(fs::read(root.join("note/a/image.png")).unwrap(), existing);
        assert_eq!(
            fs::read_dir(&root)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".orei-stage-"))
                .count(),
            0
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_bad_paths_and_non_png_bodies_before_publishing() {
        let root = temp();
        for path in ["/outside.png", "../outside.png", "a\\b.png", "a/./b.png"] {
            let file = AssetFile {
                path: path.into(),
                data: "data:image/png;base64,iVBORw0KGgo=".into(),
                kind: "image".into(),
            };
            assert!(publish(&root, &[file]).is_err());
        }
        let bad = AssetFile {
            path: "good.png".into(),
            data: "data:image/png;base64,AAAA".into(),
            kind: "image".into(),
        };
        assert!(publish(&root, &[bad]).is_err());
        assert!(!root.parent().unwrap().join("outside.png").exists());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn prepared_destination_round_trips_assets_and_binds_the_approved_root_to_its_handle() {
        let base = temp();
        let note_dir = base.join("notes");
        let root = base.join("attachments");
        fs::create_dir_all(&note_dir).unwrap();
        fs::create_dir_all(&root).unwrap();
        let note = note_dir.join("note.md");
        fs::write(&note, "# saved").unwrap();
        let mut registry = Registry::default();
        let prepared = registry.prepare(&note, &root).unwrap();
        assert_eq!(prepared.attachments, "../attachments");
        assert_eq!(prepared.namespace, "note");
        let (reserved_note, reserved_root) = registry.destination(&prepared.destination).unwrap();
        assert_eq!(reserved_note, fs::canonicalize(&note_dir).unwrap().join("note.md"));
        assert_eq!(reserved_root, fs::canonicalize(&root).unwrap());
        let files = [AssetFile { path: "n/v/image.png".into(), data: "data:image/png;base64,iVBORw0KGgo=".into(), kind: "image".into() }];
        publish(&reserved_root, &files).unwrap();
        registry.finish_destination(&prepared.destination, Some("named-handle")).unwrap();
        let reference = [AssetReference { path: "../attachments/n/v/image.png".into(), kind: "image".into() }];
        assert!(references_within_root(&note, &reserved_root, &reference).unwrap());
        assert!(!references_within_root(&note, &note_dir, &reference).unwrap());
        let resolved = read_authorized(&note, &reserved_root, &reference).unwrap();
        assert_eq!(resolved[0].data, files[0].data);
        assert_eq!(registry.root("named-handle").unwrap(), fs::canonicalize(&root).unwrap());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn prepare_derives_a_sanitized_namespace_from_the_note_stem() {
        let base = temp();
        let root = base.join("attachments");
        fs::create_dir_all(&root).unwrap();
        let note = base.join("My Note.md");
        fs::write(&note, "note").unwrap();
        let mut registry = Registry::default();
        // Storage names must survive any user-chosen note name, so the stem is reduced to one
        // safe path segment while the opaque destination stays the registry key.
        let prepared = registry.prepare(&note, &root).unwrap();
        assert_eq!(prepared.namespace, "My-Note");
        assert!(prepared.destination.starts_with("orei-markdown-"));
        assert_ne!(prepared.destination, prepared.namespace);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn same_folder_uses_dot_and_settings_reassignment_cannot_change_existing_approval() {
        let base = temp();
        let first = base.join("first");
        let second = base.join("second");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        let mut registry = Registry::default();
        let prepared = registry.prepare(&first.join("note.md"), &first).unwrap();
        assert_eq!(prepared.attachments, ".");
        registry.finish_destination(&prepared.destination, Some("handle-one")).unwrap();
        let other = registry.prepare(&second.join("note.md"), &second).unwrap();
        registry.finish_destination(&other.destination, Some("handle-two")).unwrap();
        assert_eq!(registry.root("handle-one").unwrap(), fs::canonicalize(&first).unwrap());
        assert_eq!(registry.root("handle-two").unwrap(), fs::canonicalize(&second).unwrap());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn missing_attachments_are_named_instead_of_reported_as_unauthorized_or_escaping() {
        let base = temp();
        let note_dir = base.join("notes");
        let root = base.join("assets");
        fs::create_dir_all(&note_dir).unwrap();
        fs::create_dir_all(&root).unwrap();
        let note = note_dir.join("note.md");
        fs::write(&note, "note").unwrap();
        let missing = [AssetReference { path: "../assets/gone.png".into(), kind: "image".into() }];
        // A missing file must not read as "outside the approved root", or the caller would
        // offer a folder picker that cannot bring the file back.
        assert!(references_within_root(&note, &root, &missing).unwrap());
        assert_eq!(read_authorized(&note, &root, &missing).err().unwrap(), "Missing attachment: ../assets/gone.png");
        assert_eq!(
            read_authorized(&note, &base.join("absent"), &missing).err().unwrap(),
            format!("Attachments folder not found: {}", base.join("absent").display())
        );
        let escaping = [AssetReference { path: "../outside.png".into(), kind: "image".into() }];
        fs::write(base.join("outside.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        assert!(!references_within_root(&note, &root, &escaping).unwrap());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn collisions_and_unapproved_or_symlink_paths_fail_without_changing_the_note_or_partial_assets() {
        let base = temp();
        let note_dir = base.join("notes");
        let root = base.join("assets");
        fs::create_dir_all(&note_dir).unwrap();
        fs::create_dir_all(root.join("n/v")).unwrap();
        let note = note_dir.join("note.md");
        fs::write(&note, "prior valid note").unwrap();
        fs::write(root.join("n/v/existing.png"), b"old").unwrap();
        let files = [
            AssetFile { path: "n/v/new.png".into(), data: "data:image/png;base64,iVBORw0KGgo=".into(), kind: "image".into() },
            AssetFile { path: "n/v/existing.png".into(), data: "data:image/png;base64,iVBORw0KGgo=".into(), kind: "image".into() },
        ];
        assert!(publish(&root, &files).is_err());
        assert!(!root.join("n/v/new.png").exists());
        assert_eq!(fs::read_to_string(&note).unwrap(), "prior valid note");
        let outside = base.join("outside.png");
        fs::write(&outside, b"\x89PNG\r\n\x1a\n").unwrap();
        let reference = [AssetReference { path: "../outside.png".into(), kind: "image".into() }];
        assert!(read_authorized(&note, &note_dir, &reference).is_err());
        assert_eq!(read_authorized(&note, &base, &reference).unwrap().len(), 1);
        #[cfg(unix)] {
            std::os::unix::fs::symlink(&outside, note_dir.join("linked.png")).unwrap();
            let linked = [AssetReference { path: "linked.png".into(), kind: "image".into() }];
            assert!(read_authorized(&note, &base, &linked).is_err());
        }
        fs::remove_dir_all(base).unwrap();
    }
}
