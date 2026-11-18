use std::{fs, io::{Read, Write}, path::{Path, PathBuf}, sync::atomic::{AtomicU64, Ordering}};
use std::collections::HashMap;

const LIMIT: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, serde::Serialize)]
pub struct OpenDocument { pub handle: String, pub name: String, pub text: String, pub revision: u64 }

/// One version this process replaced but did not create, kept for comparison. `text` is `None`
/// when the retained bytes were not UTF-8; `path` lets the UI name the preserved file so it can
/// be inspected outside the app even when it cannot be shown inside it.
#[derive(Clone, Debug, serde::Serialize)]
pub struct RetainedVersion { pub member: String, pub text: Option<String>, pub path: String }

/// The result of an explicit "Keep Local": the adopted revision and any version that was
/// displaced even though it was not the one compared (a late external edit arriving after the
/// dialog was filled). The UI names the retained path instead of losing the write silently.
#[derive(Clone, Debug, serde::Serialize)]
pub struct OverwriteOutcome { pub revision: u64, pub retained: Vec<RetainedVersion> }

/// The on-disk view of an open document. `changed` compares the disk bytes with the baseline
/// this process last wrote or adopted; `missing` distinguishes a deleted destination from an
/// unreadable one. Inspecting never writes or adopts.
#[derive(Clone, Debug, serde::Serialize)]
pub struct DocumentState {
    pub revision: u64,
    pub text: Option<String>,
    pub missing: bool,
    pub changed: bool,
    pub error: Option<String>,
    pub retained: Vec<RetainedVersion>,
}

/// A replaced version and the snapshot this process published over it. `ours` is the only
/// baseline a later restore may replace, so a newer external edit is never discarded.
pub(crate) struct RetainedContent {
    pub member: String,
    pub path: PathBuf,
    pub text: Option<String>,
    pub ours: String,
}

#[derive(Default)]
struct Entry { path: PathBuf, revision: u64, baseline: String, retained: Vec<RetainedContent> }

impl Entry {
    /// Removes retained staging files only while they still hold the bytes we recorded: a path
    /// substituted by another process is not ours to delete.
    fn cleanup_retained(&mut self) {
        for retained in self.retained.drain(..) {
            if let Some(text) = retained.text {
                if std::fs::read(&retained.path).ok().is_some_and(|bytes| bytes == text.as_bytes()) {
                    let _ = std::fs::remove_file(&retained.path);
                }
            }
        }
    }

    fn retain(&mut self, member: String, retained: Option<RetainedContent>) {
        if let Some(mut retained) = retained {
            // Drop an older preserved copy for the same member instead of leaking its path.
            self.retained.retain(|existing| {
                if existing.member != member { return true; }
                if let Some(text) = &existing.text {
                    if std::fs::read(&existing.path).ok().is_some_and(|bytes| bytes == text.as_bytes()) {
                        let _ = std::fs::remove_file(&existing.path);
                    }
                }
                false
            });
            retained.member = member;
            self.retained.push(retained);
        }
    }

    /// Puts the preserved version back on disk before adopting it. The replacement is
    /// conditional on the destination still holding this process's snapshot, so a later
    /// external edit is reported rather than overwritten.
    fn restore_retained(&mut self) -> Result<(), String> {
        let Some(retained) = self.retained.first() else { return Ok(()) };
        let (staging, destination, external, ours) = (retained.path.clone(), self.path.clone(), retained.text.clone(), retained.ours.clone());
        let Some(external) = external else {
            return Err(format!("The version replaced by the last save is not UTF-8. It remains at {}", staging.display()));
        };
        let mut replacement = Retention::default();
        match replace(&destination, &ours, &external, &mut replacement) {
            Ok(()) => { self.cleanup_retained(); Ok(()) }
            Err(message) => {
                if let Some(newer) = replacement.retained.take() { self.retain("document".into(), Some(newer)); }
                Err(format!("Could not restore the preserved version. {message}"))
            }
        }
    }
}

#[derive(Default)]
pub struct Registry { entries: HashMap<String, Entry> }
impl Registry {
    pub fn authorize(&mut self, path: PathBuf) -> Result<OpenDocument, String> {
        let text = read(&path)?;
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let handle = format!("orei-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed));
        let name = path.file_name().and_then(|n| n.to_str()).ok_or("Invalid document name")?.to_owned();
        self.entries.insert(handle.clone(), Entry { path, revision: 1, baseline: text.clone(), retained: Vec::new() });
        Ok(OpenDocument { handle, name, text, revision: 1 })
    }
    pub fn write(&mut self, handle: &str, revision: u64, text: &str) -> Result<u64, String> {
        if text.len() as u64 > LIMIT { return Err("Document exceeds 8 MiB".into()); }
        let entry = self.entries.get_mut(handle).ok_or("Unknown document handle")?;
        if revision != entry.revision { return Err("Document revision conflict".into()); }
        let mut retention = Retention::default();
        let outcome = replace(&entry.path, &entry.baseline, text, &mut retention);
        if retention.retained.is_some() {
            let member = entry.path.file_name().and_then(|name| name.to_str()).unwrap_or("document").to_owned();
            entry.retain(member, retention.retained.take());
        }
        outcome?;
        entry.revision += 1;
        entry.baseline = text.to_owned();
        Ok(entry.revision)
    }

    /// Reads the destination without adopting it. The caller compares versions and decides
    /// whether to reload or overwrite; a watcher notification is never itself permission.
    pub fn inspect(&self, handle: &str) -> Result<DocumentState, String> {
        let entry = self.entries.get(handle).ok_or("Unknown document handle")?;
        let retained = retained_versions(&entry.retained);
        match std::fs::symlink_metadata(&entry.path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(DocumentState {
                revision: entry.revision, text: None, missing: true, changed: true,
                error: Some("The file no longer exists at its saved location".into()), retained,
            }),
            Err(error) => Ok(DocumentState {
                revision: entry.revision, text: None, missing: false, changed: true,
                error: Some(error.to_string()), retained,
            }),
            Ok(metadata) => {
                if !metadata.is_file() {
                    return Ok(DocumentState {
                        revision: entry.revision, text: None, missing: false, changed: true,
                        error: Some("The saved location is no longer a regular file".into()), retained,
                    });
                }
                match read_utf8(&entry.path) {
                    Ok(text) => Ok(DocumentState {
                        revision: entry.revision, changed: text != entry.baseline,
                        text: Some(text), missing: false, error: None, retained,
                    }),
                    Err(error) => Ok(DocumentState {
                        revision: entry.revision, text: None, missing: false, changed: true,
                        error: Some(error), retained,
                    }),
                }
            }
        }
    }

    /// Adopts the disk content as the new baseline for explicit "Reload Disk". If the last
    /// save displaced an external version into private retention, that version is put back
    /// first, so the version shown for comparison is the one that is adopted.
    pub fn reload(&mut self, handle: &str) -> Result<OpenDocument, String> {
        let entry = self.entries.get_mut(handle).ok_or("Unknown document handle")?;
        entry.restore_retained()?;
        let text = read_utf8(&entry.path)?;
        entry.revision += 1;
        entry.baseline = text.clone();
        entry.cleanup_retained();
        Ok(OpenDocument {
            handle: handle.to_owned(),
            name: entry.path.file_name().and_then(|name| name.to_str()).ok_or("Invalid document name")?.to_owned(),
            text,
            revision: entry.revision,
        })
    }

    /// Explicit "Keep Local": replaces the destination with the supplied snapshot without
    /// consulting the baseline. Only a user decision reaches this. `shown` is the disk version
    /// the user compared: anything else that the write displaces arrived after the comparison,
    /// so it is preserved and named in the result rather than silently discarded.
    pub fn overwrite(&mut self, handle: &str, text: &str, shown: Option<&str>) -> Result<OverwriteOutcome, String> {
        if text.len() as u64 > LIMIT { return Err("Document exceeds 8 MiB".into()); }
        let entry = self.entries.get_mut(handle).ok_or("Unknown document handle")?;
        let mut retention = Retention::default();
        let outcome = replace_forced(&entry.path, shown, text, &mut retention);
        if let Some(newer) = retention.retained.take() {
            let member = entry.path.file_name().and_then(|name| name.to_str()).unwrap_or("document").to_owned();
            entry.retain(member, Some(newer));
        } else if outcome.is_ok() {
            // The version the user saw is the one that was replaced, so any staging from an
            // earlier raced save is resolved and can be removed.
            entry.cleanup_retained();
        }
        outcome?;
        entry.revision += 1;
        entry.baseline = text.to_owned();
        Ok(OverwriteOutcome { revision: entry.revision, retained: retained_versions(&entry.retained) })
    }

    /// Drops the session. An unresolved version replaced by a raced save is put back on disk
    /// first, so closing a document cannot silently discard the external writer's content.
    /// If that restore is refused, the preserved copy is left in place.
    pub fn release(&mut self, handle: &str) -> bool {
        match self.entries.remove(handle) {
            Some(mut entry) => { let _ = entry.restore_retained(); true }
            None => false,
        }
    }
}

/// A version replaced by a save that raced an external writer: the destination keeps this
/// process's snapshot and the replaced bytes stay at the private staging path for comparison.
#[derive(Default)]
pub(crate) struct Retention { pub retained: Option<RetainedContent> }

/// The serializable view of the versions this session has displaced into staging.
fn retained_versions(retained: &[RetainedContent]) -> Vec<RetainedVersion> {
    retained.iter().map(|retained| RetainedVersion {
        member: retained.member.clone(), text: retained.text.clone(), path: retained.path.display().to_string(),
    }).collect()
}

#[derive(Debug)]
enum PublishFailure { Failed(String), Conflict(String, PathBuf, Option<String>) }

/// Replace an existing file only when it still holds `baseline`. Shared by Markdown notes
/// and paired members so every writer gets the same staging, permission, and conflict rules.
pub(crate) fn replace(path: &Path, baseline: &str, text: &str, retention: &mut Retention) -> Result<(), String> {
    let disk = read_utf8(path)?;
    if disk != baseline { return Err("Document changed on disk".into()); }
    static NEXT_SAVE: AtomicU64 = AtomicU64::new(0);
    let (staged, mut file) = loop {
        let candidate = path.with_file_name(format!(".orei-save-{}-{}.tmp", std::process::id(), NEXT_SAVE.fetch_add(1, Ordering::Relaxed)));
        match fs::OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(file) => break (candidate, file),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    };
    let result: Result<(), PublishFailure> = (|| {
        if let Err(e) = file.write_all(text.as_bytes()).and_then(|()| file.sync_all()) {
            return Err(PublishFailure::Failed(format!("Could not save: {e}. A temporary file remains at {}", staged.display())));
        }
        if read_utf8(path).map_err(|e| PublishFailure::Failed(format!("Could not save: {e}. A temporary file remains at {}", staged.display())))? != disk {
            return Err(PublishFailure::Failed(format!("Document changed on disk. A temporary file remains at {}", staged.display())));
        }
        publish(&staged, path, disk.as_bytes())
    })();
    match result {
        Ok(()) => Ok(()),
        Err(PublishFailure::Failed(message)) => Err(message),
        Err(PublishFailure::Conflict(message, staged, external)) => {
            retention.retained = Some(RetainedContent { member: String::new(), path: staged, text: external, ours: text.to_owned() });
            Err(message)
        }
    }
}

/// Explicitly replace (or recreate) a destination without a baseline comparison. Only called
/// after a user chooses "Keep Local". `shown` is the disk version the user compared against:
/// a replaced version that differs from it arrived during the final poll-to-invoke window, so
/// it is kept at the private staging path and named in the outcome instead of being discarded.
pub(crate) fn replace_forced(path: &Path, shown: Option<&str>, text: &str, retention: &mut Retention) -> Result<(), String> {
    if text.len() as u64 > LIMIT { return Err("Document exceeds 8 MiB".into()); }
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Err("Could not save: the saved location is not a regular file".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return create_exclusive(path, text),
        Err(error) => return Err(format!("Could not save: {error}")),
    }
    static NEXT_SAVE: AtomicU64 = AtomicU64::new(0);
    let (staged, mut file) = loop {
        let candidate = path.with_file_name(format!(".orei-save-{}-{}.tmp", std::process::id(), NEXT_SAVE.fetch_add(1, Ordering::Relaxed)));
        match fs::OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(file) => break (candidate, file),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Could not save: {e}")),
        }
    };
    let result: Result<(), String> = (|| {
        file.write_all(text.as_bytes()).and_then(|()| file.sync_all())
            .map_err(|e| format!("Could not save: {e}. A temporary file remains at {}", staged.display()))?;
        #[cfg(target_os = "macos")]
        {
            let destination = fs::metadata(path).map_err(|e| format!("Could not save: {e}. A temporary file remains at {}", staged.display()))?;
            preserve_metadata(&destination, &staged, &format!("Nothing was overwritten and this snapshot remains at {}", staged.display()))?;
            rename_x(&staged, path, rename_flags::RENAME_SWAP)
                .map_err(|e| format!("Could not save: {e}. A temporary file remains at {}", staged.display()))?;
            // The swap left the replaced content at our private staging name. It is discarded
            // only when it is byte for byte the version shown for comparison; anything else is
            // a late external edit and stays there, named by the outcome as a retained version.
            let (preserved, keep) = match bounded_read(&staged) {
                Ok(bytes) if shown.is_some_and(|shown| bytes == shown.as_bytes()) => {
                    let _ = fs::remove_file(&staged);
                    (None, false)
                }
                Ok(bytes) => (if bytes.len() as u64 <= LIMIT { String::from_utf8(bytes).ok() } else { None }, true),
                Err(_) => (None, true),
            };
            if keep {
                retention.retained = Some(RetainedContent { member: String::new(), path: staged.clone(), text: preserved, ours: text.to_owned() });
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            // Without RENAME_SWAP a plain rename leaves no staging copy of the replaced file,
            // so a late external edit cannot be preserved on this platform (see `publish`).
            let _ = (shown, &mut *retention);
            fs::rename(&staged, path).map_err(|e| format!("Could not save: {e}. A temporary file remains at {}", staged.display()))?;
        }
        Ok(())
    })();
    result
}

fn check_path(path: &Path) -> Result<(), String> {
    if !path.extension().and_then(|s| s.to_str()).is_some_and(|s| s.eq_ignore_ascii_case("md")) {
        return Err("Expected a .md document".into());
    }
    Ok(())
}

pub fn read(path: &Path) -> Result<String, String> {
    check_path(path)?;
    read_utf8(path)
}

/// Bounded, regular-file, UTF-8 read without an extension restriction. The caller owns the
/// extension policy because paired groups contain `.mmd`, `.css`, and asset-index files.
pub(crate) fn read_utf8(path: &Path) -> Result<String, String> {
    if !fs::metadata(path).map_err(|e| e.to_string())?.is_file() { return Err("Expected a regular file".into()); }
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() { return Err("Expected a regular file".into()); }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > LIMIT { return Err("Document exceeds 8 MiB".into()); }
    String::from_utf8(bytes).map_err(|_| "Document is not UTF-8".into())
}

pub fn copy_path(path: &Path) -> Result<PathBuf, String> {
    let path = if path.extension().is_none() { path.with_extension("md") } else { path.to_owned() };
    check_path(&path)?;
    Ok(path)
}

pub fn create_copy(path: &Path, text: &str) -> Result<PathBuf, String> {
    let path = copy_path(path)?;
    if text.len() as u64 > LIMIT { return Err("Document exceeds 8 MiB".into()); }
    create_with(&path, "copy", |file| file.write_all(text.as_bytes()))?;
    Ok(path)
}

/// Create a new paired-group member never replacing an existing destination. Used for a
/// stylesheet companion or asset index that does not exist when the group is saved.
pub(crate) fn create_exclusive(path: &Path, text: &str) -> Result<(), String> {
    if text.len() as u64 > LIMIT { return Err("Document exceeds 8 MiB".into()); }
    create_with(path, "document", |file| file.write_all(text.as_bytes()))
}

/// First save: publish a new exclusive destination, then authorize it for later writes.
pub fn create_and_authorize(registry: &mut Registry, path: &Path, text: &str) -> Result<OpenDocument, String> {
    let path = create_copy(path, text)?;
    authorize_created(registry, path, text)
}

fn authorize_created(registry: &mut Registry, path: PathBuf, expected: &str) -> Result<OpenDocument, String> {
    let created = registry.authorize(path)?;
    if created.text != expected {
        registry.entries.remove(&created.handle);
        return Err("The new file changed during saving; it has not been authorized for autosave. The draft must be retained.".into());
    }
    Ok(created)
}

// macOS can atomically move a completed sibling into place. RENAME_SWAP exchanges the two
// names in one step, which a plain `fs::rename` cannot do; RENAME_EXCL moves only onto an
// unused destination name. Failed staging files are retained when they may hold content we
// did not create: unlinking by pathname could delete a replacement.
#[cfg(target_os = "macos")]
mod rename_flags {
    pub const RENAME_SWAP: u32 = 0x00000002;
    pub const RENAME_EXCL: u32 = 0x00000004;
}

#[cfg(target_os = "macos")]
fn rename_x(from: &Path, to: &Path, flags: u32) -> Result<(), std::io::Error> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    unsafe extern "C" { fn renamex_np(from: *const std::ffi::c_char, to: *const std::ffi::c_char, flags: u32) -> i32; }
    let from = CString::new(from.as_os_str().as_bytes()).map_err(|_| std::io::Error::other("Invalid staging path"))?;
    let to = CString::new(to.as_os_str().as_bytes()).map_err(|_| std::io::Error::other("Invalid destination path"))?;
    if unsafe { renamex_np(from.as_ptr(), to.as_ptr(), flags) } != 0 { return Err(std::io::Error::last_os_error()); }
    Ok(())
}

/// Replace `path` with `staged` only when the file being replaced is still what we last read.
/// The swap puts the replaced content on our private staging name, which no external writer
/// targets. On a mismatch the destination keeps the saved snapshot and the replaced content
/// is retained at the staging path: a second swap to roll back could itself overwrite a
/// newer concurrent edit, so conflicting versions are preserved side by side instead.
#[cfg(target_os = "macos")]
fn publish(staged: &Path, path: &Path, expected: &[u8]) -> Result<(), PublishFailure> {
    use rename_flags::RENAME_SWAP;
    let hint = format!(". A temporary file remains at {}", staged.display());
    let failure = |message: String| PublishFailure::Failed(message);
    let destination = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(e) => return Err(failure(format!("Could not save: {e}{hint}"))),
    };
    preserve_metadata(&destination, staged, &format!("The destination was not replaced and this snapshot remains at {}", staged.display())).map_err(failure)?;
    rename_x(staged, path, RENAME_SWAP).map_err(|e| failure(format!("Could not save: {e}{hint}")))?;
    let retained = |external: Option<String>| PublishFailure::Conflict(
        format!("Document changed on disk during the save; the destination holds this snapshot and the replaced content is retained at {}", staged.display()),
        staged.to_owned(),
        external,
    );
    match bounded_read(staged) {
        Ok(replaced) if replaced.as_slice() == expected => { let _ = fs::remove_file(staged); Ok(()) }
        Ok(replaced) => Err(retained(String::from_utf8(replaced).ok())),
        Err(_) => Err(retained(None)),
    }
}

/// Copies the destination's permission and ownership metadata onto our staging file before
/// publishing. A save is refused rather than silently changing who can read the file.
#[cfg(target_os = "macos")]
fn preserve_metadata(destination: &fs::Metadata, staged: &Path, consequence: &str) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    if let Err(e) = fs::set_permissions(staged, destination.permissions()) {
        return Err(format!("Could not preserve the file's permissions: {e}. {consequence}"));
    }
    if let Ok(ours) = fs::metadata(staged) {
        if (destination.uid(), destination.gid()) != (ours.uid(), ours.gid())
            && std::os::unix::fs::chown(staged, Some(destination.uid()), Some(destination.gid())).is_err() {
            return Err(format!("Saving would change the file's owner; {consequence}"));
        }
    }
    Ok(())
}

fn bounded_read(path: &Path) -> Result<Vec<u8>, std::io::Error> {
    let mut bytes = Vec::new();
    fs::File::open(path)?.take(LIMIT + 1).read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Without an atomic exchange there is no conditional replacement: a plain rename can
/// overwrite a concurrent edit. Named autosave stays best-effort on platforms other than
/// macOS, which are unverified in v1.
#[cfg(not(target_os = "macos"))]
fn publish(staged: &Path, path: &Path, _expected: &[u8]) -> Result<(), PublishFailure> {
    fs::rename(staged, path).map_err(|e| PublishFailure::Failed(e.to_string()))
}

#[cfg(target_os = "macos")]
fn create_with(path: &Path, label: &str, write: impl FnOnce(&mut fs::File) -> std::io::Result<()>) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let (staged, mut file) = loop {
        let candidate = parent.join(format!(".orei-copy-{}-{}.tmp", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        match fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&candidate) {
            Ok(file) => break (candidate, file),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Could not prepare the copy: {e}")),
        }
    };
    let result = (|| {
        write(&mut file)?;
        file.sync_all()?;
        rename_x(&staged, path, rename_flags::RENAME_EXCL)
    })();
    result.map_err(|e| format!("Could not save the {label}: {e}. A temporary file remains at {}; remove it when no longer needed, then retry with an unused destination name.", staged.display()))
}

#[cfg(not(target_os = "macos"))]
fn create_with(_path: &Path, _label: &str, _write: impl FnOnce(&mut fs::File) -> std::io::Result<()>) -> Result<(), String> {
    Err("Saving a new destination is not available on this platform yet.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn registry_fixture(name: &str) -> (PathBuf, Registry, OpenDocument) {
        let dir = std::env::temp_dir().join(format!("orei-registry-{name}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("doc.md");
        fs::write(&path, "original").unwrap();
        let mut registry = Registry::default();
        let doc = registry.authorize(path.clone()).unwrap();
        (path, registry, doc)
    }

    #[test]
    fn registry_rejects_stale_revision() {
        let (path, mut registry, doc) = registry_fixture("stale");
        assert_eq!(registry.write(&doc.handle, 0, "new").unwrap_err(), "Document revision conflict");
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn registry_rejects_external_change_and_preserves_it() {
        let (path, mut registry, doc) = registry_fixture("external");
        fs::write(&path, "external").unwrap();
        assert_eq!(registry.write(&doc.handle, doc.revision, "ours").unwrap_err(), "Document changed on disk");
        assert_eq!(fs::read_to_string(&path).unwrap(), "external");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn registry_successful_save_advances_baseline_and_revision() {
        let (path, mut registry, doc) = registry_fixture("success");
        assert_eq!(registry.write(&doc.handle, doc.revision, "saved").unwrap(), 2);
        assert_eq!(fs::read_to_string(&path).unwrap(), "saved");
        assert_eq!(registry.write(&doc.handle, 1, "stale").unwrap_err(), "Document revision conflict");
        assert_eq!(registry.write(&doc.handle, 2, "saved again").unwrap(), 3);
        assert_eq!(fs::read_to_string(&path).unwrap(), "saved again");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn read_validates_extension_utf8_and_size_without_writing() {
        let dir = std::env::temp_dir().join(format!("orei-read-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.md");
        fs::write(&path, b"hello").unwrap();
        assert_eq!(read(&path).unwrap(), "hello");
        assert!(read(&dir.join("test.txt")).is_err());
        fs::write(&path, [0xff]).unwrap();
        assert!(read(&path).unwrap_err().contains("UTF-8"));
        fs::File::create(&path).unwrap().set_len(LIMIT + 1).unwrap();
        assert!(read(&path).unwrap_err().contains("8 MiB"));
        assert_eq!(fs::metadata(&path).unwrap().len(), LIMIT + 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn publish_conflict_retains_the_replaced_content_and_success_removes_staging() {
        let dir = std::env::temp_dir().join(format!("orei-publish-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("doc.md");
        let staged = dir.join(".orei-publish-test.tmp");
        fs::write(&path, "external").unwrap();
        fs::write(&staged, "ours").unwrap();
        match publish(&staged, &path, b"original") {
            Err(PublishFailure::Conflict(message, retained, external)) => {
                assert!(message.contains("Document changed on disk"), "{message}");
                assert!(message.contains(&staged.display().to_string()), "{message}");
                assert_eq!(retained, staged);
                assert_eq!(external.as_deref(), Some("external"));
            }
            _ => panic!("expected a retained conflict"),
        }
        assert_eq!(fs::read_to_string(&path).unwrap(), "ours");
        assert_eq!(fs::read_to_string(&staged).unwrap(), "external");
        // After this conflict the destination holds the snapshot while the registry baseline
        // is unchanged, so a later save keeps reporting "Document changed on disk" (covered
        // by registry_rejects_external_change_and_preserves_it) until it is resolved.
        fs::write(&path, "original").unwrap();
        fs::write(&staged, "ours").unwrap();
        publish(&staged, &path, b"original").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "ours");
        assert!(!staged.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn inspect_reports_external_changes_and_deletions_without_adopting_them() {
        let (path, mut registry, doc) = registry_fixture("inspect");
        let unchanged = registry.inspect(&doc.handle).unwrap();
        assert!(!unchanged.changed);
        assert_eq!(unchanged.text.as_deref(), Some("original"));
        assert_eq!(unchanged.revision, doc.revision);

        fs::write(&path, "external").unwrap();
        let changed = registry.inspect(&doc.handle).unwrap();
        assert!(changed.changed);
        assert!(!changed.missing);
        assert_eq!(changed.text.as_deref(), Some("external"));
        assert_eq!(changed.revision, doc.revision, "inspect never adopts a revision");
        assert_eq!(fs::read_to_string(&path).unwrap(), "external");

        fs::remove_file(&path).unwrap();
        let missing = registry.inspect(&doc.handle).unwrap();
        assert!(missing.missing);
        assert!(missing.changed);
        assert_eq!(missing.text, None);
        assert!(missing.error.is_some());
        // The revision is unchanged, so the expected-revision guard still refuses a save and
        // an explicit reload is required instead of silently recreating the file.
        assert!(registry.write(&doc.handle, doc.revision, "ours").is_err());
        assert!(!path.exists());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn reload_adopts_the_disk_version_and_overwrite_keeps_the_local_one_on_request() {
        let (path, mut registry, doc) = registry_fixture("resolve");
        fs::write(&path, "external reload").unwrap();
        let reloaded = registry.reload(&doc.handle).unwrap();
        assert_eq!(reloaded.text, "external reload");
        assert_eq!(reloaded.revision, doc.revision + 1);
        assert!(!registry.inspect(&doc.handle).unwrap().changed);
        assert_eq!(registry.write(&doc.handle, reloaded.revision, "after reload").unwrap(), reloaded.revision + 1);
        assert_eq!(fs::read_to_string(&path).unwrap(), "after reload");

        fs::write(&path, "external again").unwrap();
        let outcome = registry.overwrite(&doc.handle, "keep local", Some("external again")).unwrap();
        let revision = outcome.revision;
        assert!(outcome.retained.is_empty(), "the compared version was replaced, not lost");
        assert_eq!(fs::read_to_string(&path).unwrap(), "keep local");
        assert!(!registry.inspect(&doc.handle).unwrap().changed);
        assert_eq!(registry.write(&doc.handle, revision, "autosave after keep local").unwrap(), revision + 1);
        assert_eq!(fs::read_to_string(&path).unwrap(), "autosave after keep local");

        fs::remove_file(&path).unwrap();
        let revision = registry.overwrite(&doc.handle, "recreated", None).unwrap().revision;
        assert_eq!(fs::read_to_string(&path).unwrap(), "recreated");
        assert_eq!(revision, 6);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    fn retained_content(staging: &Path, external: &str, ours: &str) -> RetainedContent {
        RetainedContent { member: String::new(), path: staging.to_owned(), text: Some(external.into()), ours: ours.into() }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn forced_overwrite_retains_a_version_that_arrived_after_the_comparison() {
        let (path, mut registry, doc) = registry_fixture("late-edit");
        // The user compared "original"; an external writer replaced it before Keep Local ran.
        fs::write(&path, "late external").unwrap();
        let outcome = registry.overwrite(&doc.handle, "keep local", Some("original")).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "keep local");
        assert_eq!(outcome.retained.len(), 1);
        let retained = outcome.retained[0].clone();
        assert_eq!(retained.member, "doc.md");
        assert_eq!(retained.text.as_deref(), Some("late external"));
        assert_eq!(fs::read_to_string(&retained.path).unwrap(), "late external");
        // The preserved version stays visible to the dialog and Reload Disk restores it.
        assert_eq!(registry.inspect(&doc.handle).unwrap().retained[0].path, retained.path);
        let reloaded = registry.reload(&doc.handle).unwrap();
        assert_eq!(reloaded.text, "late external");
        assert_eq!(fs::read_to_string(&path).unwrap(), "late external");
        assert!(!Path::new(&retained.path).exists());

        // A second Keep Local replaces only the version now shown, so nothing new is retained.
        let again = registry.overwrite(&doc.handle, "keep local again", Some("late external")).unwrap();
        assert!(again.retained.is_empty());
        assert_eq!(fs::read_to_string(&path).unwrap(), "keep local again");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn reload_restores_the_version_displaced_by_a_raced_save_and_removes_its_staging() {
        let (path, mut registry, doc) = registry_fixture("cleanup");
        let revision = registry.overwrite(&doc.handle, "published", Some("original")).unwrap().revision;
        assert_eq!(revision, doc.revision + 1);
        let staged = path.with_file_name(".orei-save-retained.tmp");
        fs::write(&staged, "external version").unwrap();
        registry.entries.get_mut(&doc.handle).unwrap().retain("doc.md".into(), Some(retained_content(&staged, "external version", "published")));

        let inspected = registry.inspect(&doc.handle).unwrap();
        assert_eq!(inspected.retained.len(), 1);
        assert_eq!(inspected.retained[0].text.as_deref(), Some("external version"));
        assert_eq!(inspected.retained[0].path, staged.display().to_string());
        assert!(staged.exists());

        // Reload puts the preserved external version back on disk instead of adopting this
        // process's snapshot, so the version shown for comparison is the one that is loaded.
        let reloaded = registry.reload(&doc.handle).unwrap();
        assert_eq!(reloaded.text, "external version");
        assert_eq!(fs::read_to_string(&path).unwrap(), "external version");
        assert!(!staged.exists());
        assert!(registry.inspect(&doc.handle).unwrap().retained.is_empty());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn replacing_a_preserved_version_removes_the_previous_staging_instead_of_accumulating() {
        let (path, mut registry, doc) = registry_fixture("retain-replace");
        let first = path.with_file_name(".orei-save-first.tmp");
        let second = path.with_file_name(".orei-save-second.tmp");
        fs::write(&first, "first external").unwrap();
        fs::write(&second, "second external").unwrap();
        {
            let entry = registry.entries.get_mut(&doc.handle).unwrap();
            entry.retain("doc.md".into(), Some(retained_content(&first, "first external", "original")));
            entry.retain("doc.md".into(), Some(retained_content(&second, "second external", "original")));
        }
        assert!(!first.exists());
        let inspected = registry.inspect(&doc.handle).unwrap();
        assert_eq!(inspected.retained.len(), 1);
        assert_eq!(inspected.retained[0].path, second.display().to_string());
        registry.release(&doc.handle);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn release_restores_a_displaced_version_and_never_deletes_a_substituted_staging_path() {
        let (path, mut registry, doc) = registry_fixture("release-restore");
        registry.overwrite(&doc.handle, "published", Some("original")).unwrap();
        let staged = path.with_file_name(".orei-save-release.tmp");
        fs::write(&staged, "external version").unwrap();
        registry.entries.get_mut(&doc.handle).unwrap().retain("doc.md".into(), Some(retained_content(&staged, "external version", "published")));
        assert!(registry.release(&doc.handle));
        // Closing discards this process's snapshot and leaves the external writer's version.
        assert_eq!(fs::read_to_string(&path).unwrap(), "external version");
        assert!(!staged.exists());

        // A staging path substituted by another process is not deleted; the external version
        // is still restored from the recorded copy.
        let mut another = Registry::default();
        let reopened = another.authorize(path.clone()).unwrap();
        another.overwrite(&reopened.handle, "published again", Some("external version")).unwrap();
        fs::write(&staged, "someone else's file").unwrap();
        another.entries.get_mut(&reopened.handle).unwrap().retain("doc.md".into(), Some(retained_content(&staged, "external version", "published again")));
        assert!(another.release(&reopened.handle));
        assert_eq!(fs::read(&path).unwrap(), b"external version");
        assert_eq!(fs::read_to_string(&staged).unwrap(), "someone else's file");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn first_save_creates_an_exclusive_destination_and_authorizes_later_writes() {
        let dir = std::env::temp_dir().join(format!("orei-first-save-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let requested = dir.join("note");
        let mut registry = Registry::default();
        let opened = create_and_authorize(&mut registry, &requested, "first").unwrap();
        assert_eq!(opened.name, "note.md");
        assert_eq!(opened.text, "first");
        assert_eq!(opened.revision, 1);
        assert!(!opened.handle.is_empty());
        assert_eq!(registry.write(&opened.handle, opened.revision, "second").unwrap(), 2);
        assert_eq!(fs::read_to_string(dir.join("note.md")).unwrap(), "second");
        assert!(create_and_authorize(&mut registry, &requested, "replacement").is_err());
        assert_eq!(fs::read_to_string(dir.join("note.md")).unwrap(), "second");
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn copy_is_create_only_and_validates_before_creating() {
        let dir = std::env::temp_dir().join(format!("orei-copy-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("copy.md");
        create_copy(&path, "first").unwrap();
        assert!(create_copy(&path, "second").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "first");
        let invalid = dir.join("bad.txt");
        assert!(create_copy(&invalid, "text").is_err());
        assert!(!invalid.exists());
        let large = dir.join("large.md");
        assert!(create_copy(&large, &"x".repeat(LIMIT as usize + 1)).is_err());
        assert!(!large.exists());
        let partial = dir.join("partial.md");
        let failure = create_with(&partial, "copy", |file| {
            file.write_all(b"partial")?;
            Err(std::io::Error::other("injected failure"))
        });
        assert!(failure.is_err());
        assert!(!partial.exists());
        assert!(fs::read_dir(&dir).unwrap().flatten().any(|entry| fs::read(entry.path()).ok().as_deref() == Some(b"partial")));
        create_copy(&partial, "retry").unwrap();
        assert_eq!(fs::read(&partial).unwrap(), b"retry");
        let raced = dir.join("raced.md");
        let result = create_with(&raced, "copy", |file| {
            file.write_all(b"our copy")?;
            fs::write(&raced, b"external file")
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&raced).unwrap(), b"external file");
        let no_extension = dir.join("plain");
        create_copy(&no_extension, "plain").unwrap();
        assert_eq!(fs::read(dir.join("plain.md")).unwrap(), b"plain");
        create_copy(&dir.join("upper.MD"), "upper").unwrap();
        assert!(dir.join("upper.MD").exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
