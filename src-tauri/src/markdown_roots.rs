use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

/// Approval memory is convenience, never authority: a recalled root authorizes reads only.
/// Writes still require a live folder picker in this process, so a stale entry can never
/// redirect an autosave. Entries are keyed by a hash of the canonical note path, which keeps
/// plaintext locations out of the file and makes a rename start from an unknown root.
const LIMIT: usize = 256;

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct Store {
    #[serde(default)]
    notes: BTreeMap<String, Entry>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    root: String,
    length: u64,
    modified: u64,
    saved_at: u64,
}

fn lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn fingerprint(metadata: &fs::Metadata) -> (u64, u64) {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_nanos() as u64)
        .unwrap_or(0);
    (metadata.len(), modified)
}

/// FNV-1a (64-bit) is enough for a local convenience key: it is not a security boundary, and
/// the fingerprint below decides whether an entry still describes the same note.
fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn key(note: &Path) -> String {
    format!("{:016x}", fnv1a_64(note.as_os_str().to_string_lossy().as_bytes()))
}

fn read(path: &Path) -> Store {
    // Missing, unreadable, or corrupt approval memory is simply empty approval memory.
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write(path: &Path, store: &Store) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid attachment root store path")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec(store).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

/// Returns the remembered root for this exact note version, if it still exists.
pub fn recall(path: &Path, note: &Path) -> Option<PathBuf> {
    let _guard = lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let note = fs::canonicalize(note).ok()?;
    let metadata = fs::metadata(&note).ok()?;
    let store = read(path);
    let entry = store.notes.get(&key(&note))?;
    if fingerprint(&metadata) != (entry.length, entry.modified) {
        return None;
    }
    let root = fs::canonicalize(&entry.root).ok()?;
    root.is_dir().then_some(root)
}

/// Records the root a user approved for this note. Store failures are reported to the caller,
/// which is expected to ignore them: remembering is an optimization, not part of the save.
pub fn remember(path: &Path, note: &Path, root: &Path) -> Result<(), String> {
    let _guard = lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let note = fs::canonicalize(note).map_err(|error| error.to_string())?;
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("Attachment root is not a directory".into());
    }
    let metadata = fs::metadata(&note).map_err(|error| error.to_string())?;
    let (length, modified) = fingerprint(&metadata);
    let mut store = read(path);
    let saved_at = now();
    store.notes.insert(key(&note), Entry {
        root: root.to_string_lossy().into_owned(),
        length,
        modified,
        saved_at,
    });
    while store.notes.len() > LIMIT {
        let Some(oldest) = store
            .notes
            .iter()
            .min_by_key(|(_, entry)| entry.saved_at)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        store.notes.remove(&oldest);
    }
    write(path, &store)
}

/// Keeps the fingerprint current after this process writes the note, so the entry recorded at
/// the first save survives ordinary autosaves. A note edited by another program stops
/// matching and is asked about once instead of silently reusing an old folder.
pub fn refresh(path: &Path, note: &Path) -> Result<(), String> {
    let _guard = lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let note = fs::canonicalize(note).map_err(|error| error.to_string())?;
    let metadata = fs::metadata(&note).map_err(|error| error.to_string())?;
    let mut store = read(path);
    let Some(entry) = store.notes.get_mut(&key(&note)) else {
        return Ok(());
    };
    (entry.length, entry.modified) = fingerprint(&metadata);
    entry.saved_at = now();
    write(path, &store)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static DIR: AtomicU64 = AtomicU64::new(0);

    fn temp() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "orei-markdown-roots-{}-{}",
            std::process::id(),
            DIR.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn fnv1a_matches_the_published_vector() {
        assert_eq!(fnv1a_64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a_64(b"a"), 0xaf63_dc4c_8601_ec8c);
    }

    #[test]
    fn remembered_roots_round_trip_and_follow_this_process_writes() {
        let base = temp();
        let store = base.join("config/attachment-roots.json");
        let note = base.join("note.md");
        let root = base.join("assets");
        fs::create_dir(&root).unwrap();
        fs::write(&note, "one").unwrap();
        remember(&store, &note, &root).unwrap();
        assert_eq!(recall(&store, &note).unwrap(), fs::canonicalize(&root).unwrap());
        // Ordinary saves change length and mtime; refresh keeps the association.
        fs::write(&note, "one and two").unwrap();
        assert!(recall(&store, &note).is_none());
        refresh(&store, &note).unwrap();
        assert_eq!(recall(&store, &note).unwrap(), fs::canonicalize(&root).unwrap());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn unknown_notes_missing_folders_and_corrupt_files_recall_nothing() {
        let base = temp();
        let store = base.join("attachment-roots.json");
        let note = base.join("note.md");
        let root = base.join("assets");
        fs::create_dir(&root).unwrap();
        fs::write(&note, "note").unwrap();
        assert!(recall(&store, &note).is_none());
        fs::write(&store, b"{ not json").unwrap();
        assert!(recall(&store, &note).is_none());
        remember(&store, &note, &root).unwrap();
        fs::remove_dir_all(&root).unwrap();
        assert!(recall(&store, &note).is_none());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn a_never_written_root_is_not_recorded() {
        let base = temp();
        let store = base.join("attachment-roots.json");
        let note = base.join("note.md");
        fs::write(&note, "note").unwrap();
        assert!(remember(&store, &note, &base.join("missing")).is_err());
        assert!(!store.exists());
        fs::remove_dir_all(base).unwrap();
    }
}
