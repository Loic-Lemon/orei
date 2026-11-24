use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

type Locations = BTreeMap<String, PathBuf>;

fn read(store: &Path) -> Locations {
    fs::read(store)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Called with the pair registry locked, and only for a file picked or created by the user.
/// A failed settings write leaves the current file open and costs one picker next launch.
pub fn remember(store: &Path, source: &Path, handle: &str) -> Option<String> {
    if !fs::symlink_metadata(source).ok()?.is_file() { return None; }
    let source = fs::canonicalize(source).ok()?;
    let mut locations = read(store);
    if let Some((id, _)) = locations.iter().find(|(_, path)| **path == source) {
        return Some(id.clone());
    }
    let time = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_nanos();
    let id = format!("{handle}-{time:x}");
    if locations.contains_key(&id) { return None; }
    locations.insert(id.clone(), source);
    fs::create_dir_all(store.parent()?).ok()?;
    let bytes = serde_json::to_vec(&locations).ok()?;
    crate::atomic_output::replace_output(store, |file| file.write_all(&bytes)).ok()?;
    Some(id)
}

/// Accepts a key from the webview and resolves it only through the native location store.
pub fn recall(store: &Path, id: &str) -> Option<PathBuf> {
    let source = read(store).remove(id)?;
    // A source or parent replaced by a symlink must go through the picker again.
    (fs::canonicalize(&source).ok()? == source && fs::symlink_metadata(&source).ok()?.is_file())
        .then_some(source)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recall_only_reopens_a_remembered_file_at_its_original_location() {
        let dir = std::env::temp_dir().join(format!(
            "orei-pair-location-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
        ));
        fs::create_dir(&dir).unwrap();
        let dir = fs::canonicalize(dir).unwrap();
        let store = dir.join("paired-locations.json");
        let source = dir.join("diagram.mmd");
        fs::write(&source, "graph TD").unwrap();
        let id = remember(&store, &source, "pair-1").unwrap();
        assert_eq!(recall(&store, &id), Some(source.clone()));
        assert_eq!(remember(&store, &source, "pair-2").as_deref(), Some(id.as_str()));
        assert_eq!(recall(&store, source.to_str().unwrap()), None);
        let moved = dir.join("moved.mmd");
        fs::rename(&source, &moved).unwrap();
        assert_eq!(recall(&store, &id), None);
        std::os::unix::fs::symlink(moved, &source).unwrap();
        assert_eq!(recall(&store, &id), None);
        fs::remove_dir_all(dir).unwrap();
    }
}
