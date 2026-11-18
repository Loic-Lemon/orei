//! Paired `.mmd`/`.css` file groups.
//!
//! A group is the diagram source, an optional stylesheet companion, and an optional adjacent
//! asset index. Members are versioned and written one at a time: the group is deliberately
//! not an atomic filesystem transaction, so a later failure is reported with the members
//! that did reach disk instead of claiming success.
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use serde::{Deserialize, Serialize};

use crate::{document_io, image_io};

const LIMIT: u64 = 8 * 1024 * 1024;
const ASSET_SUFFIX: &str = "orei-assets.json";

#[derive(Clone, Debug, Serialize)]
pub struct OpenPair {
    pub handle: String,
    pub base: String,
    pub source_name: String,
    pub source: String,
    pub css_name: Option<String>,
    pub css: Option<String>,
    pub assets_name: Option<String>,
    pub assets: Option<String>,
    pub revisions: PairRevisions,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairRevisions {
    pub source: u64,
    pub css: Option<u64>,
    pub assets: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WriteFailure {
    pub member: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct WriteOutcome {
    pub revisions: PairRevisions,
    pub written: Vec<String>,
    pub failure: Option<WriteFailure>,
    /// Versions displaced by a Keep Local that differed from the compared one, named so the
    /// dialog can show them instead of silently dropping a late external edit.
    pub retained: Vec<document_io::RetainedVersion>,
}

/// The group version the user compared in the conflict dialog, per member. Keep Local only
/// discards a replaced member that is byte for byte this version.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct ShownGroup { pub source: Option<String>, pub css: Option<String>, pub assets: Option<String> }

/// The on-disk view of an open group, read without adopting anything. `missing` names group
/// members that existed when opened but are gone; `changed` covers additions and removals too.
#[derive(Clone, Debug, Serialize)]
pub struct PairState {
    pub revisions: PairRevisions,
    pub source: Option<String>,
    pub css: Option<String>,
    pub assets: Option<String>,
    pub missing: Vec<String>,
    pub changed: bool,
    pub error: Option<String>,
    pub retained: Vec<document_io::RetainedVersion>,
}

struct Member {
    path: PathBuf,
    revision: u64,
    baseline: String,
    retained: Option<document_io::RetainedContent>,
}

impl Member {
    fn existing(path: PathBuf, baseline: String) -> Self {
        Self { path, revision: 1, baseline, retained: None }
    }
    /// A member that does not exist yet. Revision 0 only ever becomes 1 by exclusive creation.
    fn absent(path: PathBuf) -> Self {
        Self { path, revision: 0, baseline: String::new(), retained: None }
    }
    fn revision(&self) -> Option<u64> {
        (self.revision > 0).then_some(self.revision)
    }
    fn write(&mut self, text: &str) -> Result<(), String> {
        if self.revision == 0 {
            document_io::create_exclusive(&self.path, text)?;
            self.revision = 1;
        } else {
            let mut retention = document_io::Retention::default();
            let outcome = document_io::replace(&self.path, &self.baseline, text, &mut retention);
            if let Some(newer) = retention.retained.take() { self.retain(newer); }
            outcome?;
            self.revision += 1;
        }
        self.baseline = text.to_owned();
        Ok(())
    }
    /// Explicit "Keep Local": replaces the member without a baseline check. `shown` is the
    /// version the user compared, so a different one was written after the comparison and is
    /// preserved rather than discarded.
    fn force(&mut self, shown: Option<&str>, text: &str) -> Result<(), String> {
        let mut retention = document_io::Retention::default();
        let outcome = document_io::replace_forced(&self.path, shown, text, &mut retention);
        if let Some(newer) = retention.retained.take() {
            self.retain(newer);
        } else if outcome.is_ok() {
            // The compared version is the one that was replaced; older staging can go.
            self.cleanup_retained();
        }
        outcome?;
        self.revision += 1;
        self.baseline = text.to_owned();
        Ok(())
    }
    /// Adopts the current disk text as the new baseline after "Reload Disk".
    fn adopt(&mut self, text: String) {
        self.baseline = text;
        self.revision += 1;
        self.cleanup_retained();
    }
    fn cleanup_retained(&mut self) {
        if let Some(retained) = self.retained.take() {
            if let Some(text) = retained.text {
                if fs::read(&retained.path).ok().is_some_and(|bytes| bytes == text.as_bytes()) {
                    let _ = fs::remove_file(&retained.path);
                }
            }
        }
    }
    /// Replaces an older preserved copy for this member instead of leaking its staging path.
    fn retain(&mut self, retained: document_io::RetainedContent) {
        self.cleanup_retained();
        self.retained = Some(retained);
    }
    /// Puts the preserved version back on disk, conditional on the destination still holding
    /// this process's snapshot. Returns the restored text when there was something to restore.
    fn restore_retained(&mut self, member: &str) -> Result<Option<String>, String> {
        let Some(retained) = self.retained.take() else { return Ok(None) };
        if retained.text.is_none() {
            let message = format!("The {member} version replaced by the last save is not UTF-8. It remains at {}", retained.path.display());
            self.retained = Some(retained);
            return Err(message);
        }
        let external = retained.text.clone().unwrap();
        let mut replacement = document_io::Retention::default();
        match document_io::replace(&self.path, &retained.ours, &external, &mut replacement) {
            Ok(()) => {
                if fs::read(&retained.path).ok().is_some_and(|bytes| bytes == external.as_bytes()) {
                    let _ = fs::remove_file(&retained.path);
                }
                Ok(Some(external))
            }
            Err(message) => {
                if let Some(newer) = replacement.retained.take() { self.retain(newer); } else { self.retained = Some(retained); }
                Err(format!("Could not restore the preserved {member} version. {message}"))
            }
        }
    }
    fn retained_version(&self, member: &str) -> Option<document_io::RetainedVersion> {
        self.retained.as_ref().map(|retained| document_io::RetainedVersion {
            member: member.into(), text: retained.text.clone(), path: retained.path.display().to_string(),
        })
    }
}

struct Entry {
    base: String,
    source: Member,
    css: Option<Member>,
    assets: Option<Member>,
}

impl Entry {
    fn revisions(&self) -> PairRevisions {
        PairRevisions {
            source: self.source.revision,
            css: self.css.as_ref().and_then(Member::revision),
            assets: self.assets.as_ref().and_then(Member::revision),
        }
    }
    fn retained(&self) -> Vec<document_io::RetainedVersion> {
        let mut retained = Vec::new();
        if let Some(version) = self.source.retained_version("source") { retained.push(version); }
        if let Some(version) = self.css.as_ref().and_then(|member| member.retained_version("stylesheet")) { retained.push(version); }
        if let Some(version) = self.assets.as_ref().and_then(|member| member.retained_version("asset index")) { retained.push(version); }
        retained
    }
}

#[derive(Default)]
pub struct PairRegistry {
    entries: HashMap<String, Entry>,
}

impl PairRegistry {
    /// Reads every existing member and writes nothing. A missing stylesheet or asset index is
    /// normal; an existing but unreadable one is an error rather than a silent omission.
    pub fn authorize(&mut self, path: PathBuf) -> Result<OpenPair, String> {
        if !path.extension().and_then(|s| s.to_str()).is_some_and(|s| s.eq_ignore_ascii_case("mmd")) {
            return Err("Expected a .mmd document".into());
        }
        let source = document_io::read_utf8(&path)?;
        let source_name = path.file_name().and_then(|name| name.to_str()).ok_or("Invalid document name")?.to_owned();
        let stem = path.file_stem().and_then(|name| name.to_str()).ok_or("Invalid document name")?.to_owned();
        let css_path = path.with_extension("css");
        let assets_path = path.with_file_name(format!("{stem}.{ASSET_SUFFIX}"));
        let css = read_optional(&css_path, "Expected a regular stylesheet file")?;
        let assets = read_optional(&assets_path, "Expected a regular asset index file")?;
        let revisions = PairRevisions {
            source: 1,
            css: css.as_ref().map(|_| 1),
            assets: assets.as_ref().map(|_| 1),
        };
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let handle = format!("orei-pair-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed));
        let opened = OpenPair {
            handle: handle.clone(),
            base: stem,
            source_name,
            source: source.clone(),
            css_name: css.as_ref().map(|_| file_name(&css_path)),
            css: css.clone(),
            assets_name: assets.as_ref().map(|_| file_name(&assets_path)),
            assets: assets.clone(),
            revisions,
        };
        self.entries.insert(handle, Entry {
            base: opened.base.clone(),
            source: Member::existing(path, source),
            css: css.map(|text| Member::existing(css_path, text)),
            assets: assets.map(|text| Member::existing(assets_path, text)),
        });
        Ok(opened)
    }

    /// Writes the supplied members in a fixed order. `expected` must describe the whole group
    /// this session opened, and editing never adds or removes a companion implicitly.
    pub fn write(
        &mut self,
        handle: &str,
        expected: &PairRevisions,
        source: &str,
        css: Option<&str>,
        assets: Option<&str>,
    ) -> Result<WriteOutcome, String> {
        if source.len() as u64 > LIMIT { return Err("Document exceeds 8 MiB".into()); }
        if css.is_some_and(|text| text.len() as u64 > LIMIT) { return Err("Stylesheet exceeds 8 MiB".into()); }
        if assets.is_some_and(|text| text.len() as u64 > LIMIT) { return Err("Document asset index exceeds 8 MiB".into()); }
        let entry = self.entries.get_mut(handle).ok_or("Unknown document handle")?;
        if expected.source != entry.source.revision
            || expected.css != entry.css.as_ref().and_then(Member::revision)
            || expected.assets != entry.assets.as_ref().and_then(Member::revision) {
            return Err("Document revision conflict".into());
        }
        if entry.css.is_some() && css.is_none() { return Err("The opened stylesheet companion was not included in the save".into()); }
        if entry.assets.is_some() && assets.is_none() { return Err("The opened asset index was not included in the save".into()); }

        // Check every member before the first write, so an already externally changed group
        // is left untouched. A change after this check is still caught per member below.
        for (member, name) in [(Some(&entry.source), "source"), (entry.css.as_ref(), "stylesheet"), (entry.assets.as_ref(), "asset index")] {
            if let Some(member) = member {
                if document_io::read_utf8(&member.path)? != member.baseline {
                    return Ok(WriteOutcome {
                        revisions: PairRevisions { source: entry.source.revision, css: entry.css.as_ref().and_then(Member::revision), assets: entry.assets.as_ref().and_then(Member::revision) },
                        written: Vec::new(),
                        failure: Some(WriteFailure { member: name.into(), message: "Document changed on disk".into() }),
                        retained: entry.retained(),
                    });
                }
            }
        }

        let mut revisions = PairRevisions {
            source: entry.source.revision,
            css: entry.css.as_ref().and_then(Member::revision),
            assets: entry.assets.as_ref().and_then(Member::revision),
        };
        let mut written = Vec::new();
        let css_path = entry.css.as_ref().map(|member| member.path.clone()).unwrap_or_else(|| entry.source.path.with_extension("css"));
        let assets_path = entry.assets.as_ref().map(|member| member.path.clone()).unwrap_or_else(|| {
            let stem = entry.base.clone();
            entry.source.path.with_file_name(format!("{stem}.{ASSET_SUFFIX}"))
        });
        let result: Result<(), (&'static str, String)> = (|| {
            entry.source.write(source).map_err(|message| ("source", message))?;
            revisions.source = entry.source.revision;
            written.push("source".to_owned());
            if let Some(text) = css {
                write_member(&mut entry.css, css_path, text).map_err(|message| ("stylesheet", message))?;
                revisions.css = entry.css.as_ref().and_then(Member::revision);
                written.push("stylesheet".to_owned());
            }
            if let Some(text) = assets {
                write_member(&mut entry.assets, assets_path, text).map_err(|message| ("asset index", message))?;
                revisions.assets = entry.assets.as_ref().and_then(Member::revision);
                written.push("asset index".to_owned());
            }
            Ok(())
        })();
        let failure = result.err().map(|(member, message)| WriteFailure { member: member.into(), message });
        Ok(WriteOutcome { revisions, written, failure, retained: entry.retained() })
    }

    /// Reads every group member without adopting anything. Members that exist on disk but were
    /// absent when the group opened, and members that disappeared, both count as changes.
    pub fn inspect(&self, handle: &str) -> Result<PairState, String> {
        let entry = self.entries.get(handle).ok_or("Unknown document handle")?;
        let css_path = entry.source.path.with_extension("css");
        let assets_path = entry.source.path.with_file_name(format!("{}.{ASSET_SUFFIX}", entry.base));
        let mut state = PairState {
            revisions: entry.revisions(), source: None, css: None, assets: None,
            missing: Vec::new(), changed: false, error: None, retained: entry.retained(),
        };
        let read = |slot: Option<&Member>, path: &Path, label: &str, previous: bool, state: &mut PairState| -> Option<String> {
            match fs::symlink_metadata(path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    if previous { state.missing.push(label.into()); }
                    state.changed |= previous;
                    None
                }
                Err(error) => { state.changed = true; state.error = Some(format!("{label}: {error}")); None }
                Ok(metadata) if !metadata.is_file() => {
                    state.changed = true;
                    state.error = Some(format!("{label}: expected a regular file"));
                    None
                }
                Ok(_) => match document_io::read_utf8(path) {
                    Ok(text) => {
                        if slot.is_none() || slot.is_some_and(|member| member.baseline != text) { state.changed = true; }
                        Some(text)
                    }
                    Err(error) => { state.changed = true; state.error = Some(format!("{label}: {error}")); None }
                },
            }
        };
        state.source = read(Some(&entry.source), &entry.source.path, "source", true, &mut state);
        state.css = read(entry.css.as_ref(), &css_path, "stylesheet", entry.css.is_some(), &mut state);
        state.assets = read(entry.assets.as_ref(), &assets_path, "asset index", entry.assets.is_some(), &mut state);
        Ok(state)
    }

    /// Adopts the current files as the new group baseline for explicit "Reload Disk". A member
    /// version displaced by a raced save is put back first, so the version shown for comparison
    /// is the one that is adopted. Members that appeared are added; members that disappeared
    /// are dropped. Restores are per member and therefore not one atomic group transaction.
    pub fn reload(&mut self, handle: &str) -> Result<OpenPair, String> {
        let entry = self.entries.get_mut(handle).ok_or("Unknown document handle")?;
        entry.source.restore_retained("source")?;
        if let Some(css) = entry.css.as_mut() { css.restore_retained("stylesheet")?; }
        if let Some(assets) = entry.assets.as_mut() { assets.restore_retained("asset index")?; }
        let path = entry.source.path.clone();
        let base = entry.base.clone();
        let source = document_io::read_utf8(&path)?;
        let source_name = file_name(&path);
        let css_path = path.with_extension("css");
        let assets_path = path.with_file_name(format!("{base}.{ASSET_SUFFIX}"));
        let css = read_optional(&css_path, "Expected a regular stylesheet file")?;
        let assets = read_optional(&assets_path, "Expected a regular asset index file")?;

        entry.source.adopt(source.clone());
        entry.css = match (entry.css.take(), css) {
            (Some(mut member), Some(text)) => { member.adopt(text); Some(member) }
            (None, Some(text)) => Some(Member::existing(css_path.clone(), text)),
            (Some(mut member), None) => { member.cleanup_retained(); None }
            (None, None) => None,
        };
        entry.assets = match (entry.assets.take(), assets) {
            (Some(mut member), Some(text)) => { member.adopt(text); Some(member) }
            (None, Some(text)) => Some(Member::existing(assets_path.clone(), text)),
            (Some(mut member), None) => { member.cleanup_retained(); None }
            (None, None) => None,
        };
        Ok(OpenPair {
            handle: handle.to_owned(),
            base,
            source_name,
            source,
            css_name: entry.css.as_ref().map(|_| file_name(&css_path)),
            css: entry.css.as_ref().map(|member| member.baseline.clone()),
            assets_name: entry.assets.as_ref().map(|_| file_name(&assets_path)),
            assets: entry.assets.as_ref().map(|member| member.baseline.clone()),
            revisions: entry.revisions(),
        })
    }

    /// Explicit "Keep Local": writes the supplied local snapshot over the files on disk
    /// without a baseline comparison. Members the snapshot does not include are left in place;
    /// nothing is deleted. Partial writes report which members reached disk.
    pub fn overwrite(&mut self, handle: &str, source: &str, css: Option<&str>, assets: Option<&str>, shown: Option<&ShownGroup>) -> Result<WriteOutcome, String> {
        if source.len() as u64 > LIMIT { return Err("Document exceeds 8 MiB".into()); }
        if css.is_some_and(|text| text.len() as u64 > LIMIT) { return Err("Stylesheet exceeds 8 MiB".into()); }
        if assets.is_some_and(|text| text.len() as u64 > LIMIT) { return Err("Document asset index exceeds 8 MiB".into()); }
        let entry = self.entries.get_mut(handle).ok_or("Unknown document handle")?;
        let css_path = entry.css.as_ref().map(|member| member.path.clone()).unwrap_or_else(|| entry.source.path.with_extension("css"));
        let assets_path = entry.assets.as_ref().map(|member| member.path.clone()).unwrap_or_else(|| {
            entry.source.path.with_file_name(format!("{}.{ASSET_SUFFIX}", entry.base))
        });
        let mut revisions = entry.revisions();
        let mut written = Vec::new();
        let compared = shown.cloned().unwrap_or_default();
        let result: Result<(), (&'static str, String)> = (|| {
            entry.source.force(compared.source.as_deref(), source).map_err(|message| ("source", message))?;
            revisions.source = entry.source.revision;
            written.push("source".to_owned());
            if let Some(text) = css {
                force_member(&mut entry.css, css_path, compared.css.as_deref(), text).map_err(|message| ("stylesheet", message))?;
                revisions.css = entry.css.as_ref().and_then(Member::revision);
                written.push("stylesheet".to_owned());
            }
            if let Some(text) = assets {
                force_member(&mut entry.assets, assets_path, compared.assets.as_deref(), text).map_err(|message| ("asset index", message))?;
                revisions.assets = entry.assets.as_ref().and_then(Member::revision);
                written.push("asset index".to_owned());
            }
            Ok(())
        })();
        let failure = result.err().map(|(member, message)| WriteFailure { member: member.into(), message });
        Ok(WriteOutcome { revisions, written, failure, retained: entry.retained() })
    }

    /// Drops the session. Versions displaced into retention by a raced save are put back on
    /// disk first, so closing cannot silently discard an external writer's content. A restore
    /// that is refused leaves its preserved copy in place.
    pub fn release(&mut self, handle: &str) -> bool {
        match self.entries.remove(handle) {
            Some(mut entry) => {
                let _ = entry.source.restore_retained("source");
                if let Some(css) = entry.css.as_mut() { let _ = css.restore_retained("stylesheet"); }
                if let Some(assets) = entry.assets.as_mut() { let _ = assets.restore_retained("asset index"); }
                true
            }
            None => false,
        }
    }

    /// Creates a new file group at a destination chosen for Save As. Every member is created
    /// exclusively: an existing source, stylesheet or asset-index name refuses the whole
    /// operation before anything is written. The group is not atomic, so a failure after the
    /// first member reports what reached disk and leaves the original document untouched.
    pub fn create(&mut self, path: PathBuf, source: &str, css: &str, assets: Option<&str>) -> Result<OpenPair, String> {
        create_group(&path, source, css, assets)?;
        let opened = self.authorize(path).map_err(|error| {
            format!("{error} The new files remain at the chosen destination; the document was not associated.")
        })?;
        if opened.source != source || opened.css.as_deref() != Some(css) || opened.assets.as_deref() != assets {
            self.entries.remove(&opened.handle);
            return Err("The new paired files changed after they were written; the document was not associated. The files remain at the chosen destination.".into());
        }
        Ok(opened)
    }

    /// Writes a new file group without opening it. Save Copy keeps the current document's
    /// association, so no registry entry is retained.
    pub fn create_copy(&self, path: PathBuf, source: &str, css: &str, assets: Option<&str>) -> Result<(), String> {
        create_group(&path, source, css, assets)
    }

    /// Reads one relative PNG referenced by the source, bounded to the document's directory.
    /// The webview supplies a reference, never an absolute path.
    pub fn read_asset(&self, handle: &str, reference: &str) -> Result<String, String> {
        let entry = self.entries.get(handle).ok_or("Unknown document handle")?;
        if !valid_reference(reference) { return Err("Unsupported document asset reference".into()); }
        if !reference.to_ascii_lowercase().ends_with(".png") { return Err("Unsupported document asset type".into()); }
        let parent = entry.source.path.parent().filter(|path| !path.as_os_str().is_empty()).unwrap_or(Path::new("."));
        let joined = parent.join(reference);
        let root = fs::canonicalize(parent).map_err(|error| error.to_string())?;
        let resolved = fs::canonicalize(&joined).map_err(|_| format!("Missing document asset: {reference}"))?;
        if !resolved.starts_with(&root) { return Err("Unsupported document asset reference".into()); }
        if !fs::metadata(&resolved).map_err(|error| error.to_string())?.is_file() {
            return Err(format!("Missing document asset: {reference}"));
        }
        let bytes = bounded_bytes(&resolved, image_io::IMAGE_BYTES).map_err(|error| format!("Could not read {reference}: {error}"))?;
        if !bytes.starts_with(&image_io::PNG_SIGNATURE) { return Err(format!("Unsupported document asset: {reference}")); }
        Ok(image_io::encode(&bytes))
    }
}

fn create_group(path: &Path, source: &str, css: &str, assets: Option<&str>) -> Result<(), String> {
    if !path.extension().and_then(|s| s.to_str()).is_some_and(|s| s.eq_ignore_ascii_case("mmd")) {
        return Err("Expected a .mmd destination".into());
    }
    let stem = path.file_stem().and_then(|name| name.to_str()).filter(|name| !name.is_empty())
        .ok_or("Invalid document name")?.to_owned();
    if source.len() as u64 > LIMIT { return Err("Document exceeds 8 MiB".into()); }
    if css.len() as u64 > LIMIT { return Err("Stylesheet exceeds 8 MiB".into()); }
    if assets.is_some_and(|text| text.len() as u64 > LIMIT) { return Err("Document asset index exceeds 8 MiB".into()); }

    let css_path = path.with_extension("css");
    let assets_path = path.with_file_name(format!("{stem}.{ASSET_SUFFIX}"));
    // Every group member is checked before the first write, including an optional index we
    // do not plan to write: a stray index beside the new source would otherwise be adopted
    // when the file is reopened later.
    for candidate in [path, css_path.as_path(), assets_path.as_path()] {
        if destination_exists(candidate)? {
            return Err(format!(
                "A destination file already exists: {}. Choose an unused name; nothing was written.",
                file_name(candidate)
            ));
        }
    }

    let progress = |written: &[&str]| {
        if written.is_empty() { "No files in the group were created.".to_owned() }
        else { format!("The {} reached disk.", written.join(", ")) }
    };
    let mut written: Vec<&str> = Vec::new();
    if let Err(error) = document_io::create_exclusive(path, source) {
        return Err(format!("The source could not be created: {error} {} The original document and its files were not changed.", progress(&written)));
    }
    written.push("source");
    if let Err(error) = document_io::create_exclusive(&css_path, css) {
        return Err(format!("The stylesheet could not be created: {error} {} The original document and its files were not changed.", progress(&written)));
    }
    written.push("stylesheet");
    if let Some(text) = assets {
        if let Err(error) = document_io::create_exclusive(&assets_path, text) {
            return Err(format!("The asset index could not be created: {error} {} The original document and its files were not changed.", progress(&written)));
        }
    }
    Ok(())
}

fn destination_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn valid_reference(reference: &str) -> bool {
    if reference.is_empty() || reference.len() > 512 || reference.contains(['\0', '\r', '\n']) || reference.contains('\\') {
        return false;
    }
    let path = Path::new(reference);
    if path.is_absolute() { return false; }
    let mut normal = false;
    for component in path.components() {
        match component {
            Component::Normal(part) if !part.is_empty() => normal = true,
            _ => return false,
        }
    }
    normal
}

fn read_optional(path: &Path, kind_error: &str) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() { return Err(kind_error.into()); }
            document_io::read_utf8(path).map(Some)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn file_name(path: &Path) -> String {
    path.file_name().and_then(|name| name.to_str()).unwrap_or_default().to_owned()
}

fn write_member(slot: &mut Option<Member>, path: PathBuf, text: &str) -> Result<(), String> {
    match slot {
        Some(member) => member.write(text),
        None => {
            let mut member = Member::absent(path);
            member.write(text)?;
            *slot = Some(member);
            Ok(())
        }
    }
}

fn force_member(slot: &mut Option<Member>, path: PathBuf, shown: Option<&str>, text: &str) -> Result<(), String> {
    match slot {
        Some(member) => member.force(shown, text),
        None => {
            let mut member = Member::absent(path);
            member.force(shown, text)?;
            *slot = Some(member);
            Ok(())
        }
    }
}

fn bounded_bytes(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > limit { return Err("Asset exceeds the supported size".into()); }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn directory(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("orei-pair-{name}-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn png() -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        bytes.extend_from_slice(b"rest of a tiny fixture");
        bytes
    }

    #[test]
    fn authorize_reads_the_group_and_writes_nothing() {
        let dir = directory("authorize");
        let source = dir.join("diagram.mmd");
        let css = dir.join("diagram.css");
        let assets = dir.join("diagram.orei-assets.json");
        fs::write(&source, "%% comment\nflowchart LR\n  A --> B\n").unwrap();
        fs::write(&css, "/* keep */\n.node { color: red; }\n").unwrap();
        fs::write(&assets, "{\"format\":\"orei-paired-assets\",\"version\":1,\"assets\":{}}").unwrap();
        let before = [fs::read(&source).unwrap(), fs::read(&css).unwrap(), fs::read(&assets).unwrap()];
        let mut registry = PairRegistry::default();
        let opened = registry.authorize(source.clone()).unwrap();
        assert_eq!(opened.base, "diagram");
        assert_eq!(opened.source_name, "diagram.mmd");
        assert_eq!(opened.css_name.as_deref(), Some("diagram.css"));
        assert_eq!(opened.assets_name.as_deref(), Some("diagram.orei-assets.json"));
        assert_eq!(opened.source, "%% comment\nflowchart LR\n  A --> B\n");
        assert_eq!(opened.css.as_deref(), Some("/* keep */\n.node { color: red; }\n"));
        assert_eq!(opened.revisions, PairRevisions { source: 1, css: Some(1), assets: Some(1) });
        assert!(!opened.handle.is_empty());
        assert_eq!([fs::read(&source).unwrap(), fs::read(&css).unwrap(), fs::read(&assets).unwrap()], before);
    }

    #[test]
    fn missing_companions_are_absent_and_create_nothing() {
        let dir = directory("missing");
        let source = dir.join("standalone.mmd");
        fs::write(&source, "graph TD\n").unwrap();
        let mut registry = PairRegistry::default();
        let opened = registry.authorize(source.clone()).unwrap();
        assert_eq!(opened.css, None);
        assert_eq!(opened.assets, None);
        assert_eq!(opened.revisions, PairRevisions { source: 1, css: None, assets: None });
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        assert!(!dir.join("standalone.css").exists());
    }

    #[test]
    fn a_standalone_save_does_not_create_a_stylesheet_companion() {
        let dir = directory("standalone-save");
        let source = dir.join("standalone.mmd");
        fs::write(&source, "graph TD\n").unwrap();
        let mut registry = PairRegistry::default();
        let opened = registry.authorize(source.clone()).unwrap();
        let outcome = registry.write(&opened.handle, &opened.revisions, "graph TD\n  A --> B\n", None, None).unwrap();
        assert!(outcome.failure.is_none());
        assert_eq!(outcome.written, vec!["source"]);
        assert_eq!(outcome.revisions, PairRevisions { source: 2, css: None, assets: None });
        assert_eq!(fs::read_to_string(&source).unwrap(), "graph TD\n  A --> B\n");
        assert!(!dir.join("standalone.css").exists());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn a_new_stylesheet_and_asset_index_are_created_without_replacing_existing_files() {
        let dir = directory("create-companion");
        let source = dir.join("pair.mmd");
        fs::write(&source, "graph TD\n").unwrap();
        let mut registry = PairRegistry::default();
        let opened = registry.authorize(source.clone()).unwrap();
        let outcome = registry.write(&opened.handle, &opened.revisions, "graph TD\n", Some("/* memory edited */\n"), Some("{\"assets\":{}}")).unwrap();
        assert_eq!(outcome.failure, None);
        assert_eq!(outcome.written, vec!["source", "stylesheet", "asset index"]);
        assert_eq!(outcome.revisions, PairRevisions { source: 2, css: Some(1), assets: Some(1) });
        assert_eq!(fs::read_to_string(dir.join("pair.css")).unwrap(), "/* memory edited */\n");
        assert_eq!(fs::read_to_string(dir.join("pair.orei-assets.json")).unwrap(), "{\"assets\":{}}");

        // A second, independent group pointing at the same names must not overwrite them.
        let mut other = PairRegistry::default();
        let reopened = other.authorize(source.clone()).unwrap();
        let raced = dir.join("pair.css");
        fs::write(&raced, "external stylesheet").unwrap();
        let failed = other.write(&reopened.handle, &reopened.revisions, "graph TD\n", Some("ours"), Some("{}")).unwrap();
        let failure = failed.failure.expect("expected a companion conflict");
        assert_eq!(failure.member, "stylesheet");
        assert!(failed.written.is_empty());
        assert_eq!(fs::read_to_string(&raced).unwrap(), "external stylesheet");
        assert_eq!(failed.revisions.source, 1);
        assert_eq!(fs::read_to_string(&source).unwrap(), "graph TD\n");
    }

    #[test]
    fn partial_group_writes_report_written_members_and_allow_a_resynchronized_retry() {
        let dir = directory("partial");
        let source = dir.join("pair.mmd");
        fs::write(&source, "original source").unwrap();
        let mut registry = PairRegistry::default();
        let opened = registry.authorize(source.clone()).unwrap();
        // A companion appears after opening, but a stylesheet edit now asks to create one.
        // The source is written first; exclusive creation refuses to replace the new file.
        fs::write(dir.join("pair.css"), "external css").unwrap();
        let outcome = registry.write(&opened.handle, &opened.revisions, "new source", Some("new css"), None).unwrap();
        let failure = outcome.failure.clone().unwrap();
        assert_eq!(failure.member, "stylesheet");
        assert_eq!(outcome.written, vec!["source"]);
        assert_eq!(outcome.revisions, PairRevisions { source: 2, css: None, assets: None });
        assert_eq!(fs::read_to_string(&source).unwrap(), "new source");
        assert_eq!(fs::read_to_string(dir.join("pair.css")).unwrap(), "external css");

        // Retrying with the reported revisions still refuses to overwrite the new companion.
        let retried = registry.write(&opened.handle, &outcome.revisions, "newer source", Some("ours"), None);
        assert!(retried.unwrap().failure.is_some());
        assert_eq!(fs::read_to_string(dir.join("pair.css")).unwrap(), "external css");
    }

    #[test]
    fn an_asset_index_failure_reports_earlier_members_and_never_replaces_the_new_index() {
        let dir = directory("asset-failure");
        let source = dir.join("pair.mmd");
        let css = dir.join("pair.css");
        fs::write(&source, "original source").unwrap();
        fs::write(&css, "original css").unwrap();
        let mut registry = PairRegistry::default();
        let opened = registry.authorize(source.clone()).unwrap();
        // The index appears after opening; saving the group must not replace it just because
        // the earlier members are ours to update.
        let index = dir.join("pair.orei-assets.json");
        fs::write(&index, "external index").unwrap();
        let outcome = registry.write(&opened.handle, &opened.revisions, "new source", Some("new css"), Some("{}")).unwrap();
        let failure = outcome.failure.clone().unwrap();
        assert_eq!(failure.member, "asset index");
        assert_eq!(outcome.written, vec!["source", "stylesheet"]);
        assert_eq!(outcome.revisions, PairRevisions { source: 2, css: Some(2), assets: None });
        assert_eq!(fs::read_to_string(&source).unwrap(), "new source");
        assert_eq!(fs::read_to_string(&css).unwrap(), "new css");
        assert_eq!(fs::read_to_string(&index).unwrap(), "external index");

        // The reported revisions describe what actually reached disk, so a retry continues
        // from them and still refuses the conflicting index.
        let retried = registry.write(&opened.handle, &outcome.revisions, "newer source", Some("newer css"), Some("{}")).unwrap();
        assert_eq!(retried.failure.unwrap().member, "asset index");
        assert_eq!(retried.written, vec!["source", "stylesheet"]);
        assert_eq!(fs::read_to_string(&index).unwrap(), "external index");
        assert_eq!(fs::read_to_string(&source).unwrap(), "newer source");
        assert_eq!(fs::read_to_string(&css).unwrap(), "newer css");
    }

    #[test]
    fn unreadable_or_non_file_companions_refuse_to_open() {
        let dir = directory("bad-companions");
        let binary = dir.join("binary.mmd");
        fs::write(&binary, "graph TD\n").unwrap();
        fs::write(dir.join("binary.css"), [0xff]).unwrap();
        let mut registry = PairRegistry::default();
        assert!(registry.authorize(binary).unwrap_err().contains("UTF-8"));

        let folder = dir.join("folder.mmd");
        fs::write(&folder, "graph TD\n").unwrap();
        fs::create_dir(dir.join("folder.css")).unwrap();
        assert!(registry.authorize(folder).unwrap_err().contains("regular stylesheet"));
    }

    #[test]
    fn stale_revisions_and_external_changes_are_refused() {
        let dir = directory("conflict");
        let source = dir.join("pair.mmd");
        fs::write(&source, "original").unwrap();
        let mut registry = PairRegistry::default();
        let opened = registry.authorize(source.clone()).unwrap();
        let stale = PairRevisions { source: 9, css: None, assets: None };
        assert_eq!(registry.write(&opened.handle, &stale, "ours", None, None).unwrap_err(), "Document revision conflict");
        fs::write(&source, "external").unwrap();
        let failed = registry.write(&opened.handle, &opened.revisions, "ours", None, None).unwrap();
        assert_eq!(failed.failure.unwrap().message, "Document changed on disk");
        assert_eq!(fs::read_to_string(&source).unwrap(), "external");
    }

    #[test]
    fn saves_preserve_comments_and_whitespace_byte_for_byte() {
        let dir = directory("preserve");
        let source = dir.join("pair.mmd");
        let css = dir.join("pair.css");
        fs::write(&source, "%% keep\nflowchart LR\n\n   A[ spaced ] --> B\n").unwrap();
        fs::write(&css, "/* keep */\n.a {\n  color : red ;\n}\n\n").unwrap();
        let mut registry = PairRegistry::default();
        let opened = registry.authorize(source.clone()).unwrap();
        let new_source = "%% keep\nflowchart LR\n\n   A[ spaced ] --> B %% tail\n";
        let new_css = "/* keep */\n.a {\n  color : blue ;\n}\n\n";
        let outcome = registry.write(&opened.handle, &opened.revisions, new_source, Some(new_css), None).unwrap();
        assert_eq!(outcome.failure, None);
        assert_eq!(fs::read_to_string(&source).unwrap(), new_source);
        assert_eq!(fs::read_to_string(&css).unwrap(), new_css);
    }

    #[test]
    fn inaccurate_inputs_are_rejected_without_writing() {
        let dir = directory("bad-input");
        let source = dir.join("pair.mmd");
        fs::write(&source, "original").unwrap();
        let mut registry = PairRegistry::default();
        let opened = registry.authorize(source.clone()).unwrap();
        assert!(registry.write(&opened.handle, &opened.revisions, "ours", Some("css"), Some("assets")).is_ok());
        let after = fs::read_to_string(&source).unwrap();
        let missing_css = registry.write(&opened.handle, &PairRevisions { source: 2, css: Some(1), assets: Some(1) }, "newer", None, Some("assets")).unwrap_err();
        assert!(missing_css.contains("stylesheet"));
        assert_eq!(fs::read_to_string(&source).unwrap(), after);
        assert!(registry.authorize(dir.join("not-a-pair.md")).is_err());
        let big = "x".repeat(LIMIT as usize + 1);
        assert!(registry.write(&opened.handle, &PairRevisions { source: 2, css: Some(1), assets: Some(1) }, &big, Some("css"), Some("assets")).is_err());
        assert_eq!(fs::read_to_string(&source).unwrap(), after);
    }

    #[test]
    fn adjacent_png_assets_are_read_within_the_document_directory() {
        let dir = directory("asset-read");
        let source = dir.join("pair.mmd");
        fs::create_dir(dir.join("assets")).unwrap();
        fs::write(&source, "flowchart LR\n A@{ img: \"assets/local.png\" }\n").unwrap();
        fs::write(dir.join("assets/local.png"), png()).unwrap();
        let mut registry = PairRegistry::default();
        let opened = registry.authorize(source).unwrap();
        let data = registry.read_asset(&opened.handle, "assets/local.png").unwrap();
        assert!(data.starts_with("data:image/png;base64,"));
        assert_eq!(data, "data:image/png;base64,iVBORw0KGgpyZXN0IG9mIGEgdGlueSBmaXh0dXJl");
        assert!(registry.read_asset(&opened.handle, "assets/missing.png").is_err());
        assert!(registry.read_asset(&opened.handle, "../outside.png").is_err());
        assert!(registry.read_asset(&opened.handle, "assets/local.svg").is_err());
        fs::write(dir.join("not-png.png"), "not a png").unwrap();
        assert!(registry.read_asset(&opened.handle, "not-png.png").is_err());
    }

    #[test]
    fn the_image_byte_limit_keeps_the_encoded_data_url_inside_the_renderer_limit() {
        let dir = directory("asset-limit");
        let source = dir.join("pair.mmd");
        fs::write(&source, "graph TD\n").unwrap();
        let mut registry = PairRegistry::default();
        let opened = registry.authorize(source).unwrap();
        let mut bytes = png();
        bytes.resize(image_io::IMAGE_BYTES as usize, 0);
        fs::write(dir.join("limit.png"), &bytes).unwrap();
        let data = registry.read_asset(&opened.handle, "limit.png").unwrap();
        assert!(data.len() <= 2_000_000, "encoded {} characters", data.len());
        bytes.push(0);
        fs::write(dir.join("over.png"), &bytes).unwrap();
        assert!(registry.read_asset(&opened.handle, "over.png").unwrap_err().contains("size"));
    }

    #[test]
    fn create_writes_an_exclusive_group_and_authorizes_following_saves() {
        let dir = directory("create-group");
        let source = dir.join("fresh.mmd");
        let index = "{\"format\":\"orei-paired-assets\",\"version\":1,\"assets\":{}}\n";
        let mut registry = PairRegistry::default();
        let opened = registry.create(source.clone(), "graph TD\n", "/* memory */\n", Some(index)).unwrap();
        assert_eq!(opened.base, "fresh");
        assert_eq!(opened.source_name, "fresh.mmd");
        assert_eq!(opened.css_name.as_deref(), Some("fresh.css"));
        assert_eq!(opened.assets_name.as_deref(), Some("fresh.orei-assets.json"));
        assert_eq!(opened.revisions, PairRevisions { source: 1, css: Some(1), assets: Some(1) });
        assert_eq!(opened.source, "graph TD\n");
        assert_eq!(fs::read_to_string(&source).unwrap(), "graph TD\n");
        assert_eq!(fs::read_to_string(dir.join("fresh.css")).unwrap(), "/* memory */\n");
        assert_eq!(fs::read_to_string(dir.join("fresh.orei-assets.json")).unwrap(), index);

        let outcome = registry.write(&opened.handle, &opened.revisions, "graph TD\n  A --> B\n", Some("/* memory */\n"), Some(index)).unwrap();
        assert!(outcome.failure.is_none());
        assert_eq!(outcome.revisions, PairRevisions { source: 2, css: Some(2), assets: Some(2) });
    }

    #[test]
    fn create_without_assets_writes_only_the_source_and_stylesheet() {
        let dir = directory("create-no-assets");
        let source = dir.join("plain.mmd");
        let mut registry = PairRegistry::default();
        let opened = registry.create(source, "graph TD\n", "css\n", None).unwrap();
        assert_eq!(opened.assets, None);
        assert_eq!(opened.revisions, PairRevisions { source: 1, css: Some(1), assets: None });
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
        assert!(!dir.join("plain.orei-assets.json").exists());
    }

    #[test]
    fn create_refuses_any_existing_group_name_before_writing_anything() {
        for (label, member) in [("source", "taken.mmd"), ("stylesheet", "taken.css"), ("assets", "taken.orei-assets.json")] {
            let dir = directory(&format!("create-conflict-{label}"));
            fs::write(dir.join(member), "external").unwrap();
            let source = dir.join("taken.mmd");
            let mut registry = PairRegistry::default();
            let failure = registry.create(source.clone(), "ours", "ours", Some("{}")).unwrap_err();
            assert!(failure.contains("already exists"), "{failure}");
            assert!(failure.contains(member), "{failure}");
            assert_eq!(fs::read_to_string(dir.join(member)).unwrap(), "external");
            if member != "taken.mmd" { assert!(!source.exists()); }
            if member != "taken.css" { assert!(!dir.join("taken.css").exists()); }
            if member != "taken.orei-assets.json" { assert!(!dir.join("taken.orei-assets.json").exists()); }
        }
    }

    #[test]
    fn create_refuses_a_stray_asset_index_even_when_it_would_not_write_one() {
        let dir = directory("create-stray-index");
        fs::write(dir.join("stray.orei-assets.json"), "external").unwrap();
        let mut registry = PairRegistry::default();
        let failure = registry.create(dir.join("stray.mmd"), "graph TD\n", "css\n", None).unwrap_err();
        assert!(failure.contains("already exists"), "{failure}");
        assert!(failure.contains("stray.orei-assets.json"), "{failure}");
        // Reopening the new source later would adopt the stray index, so refuse before writing.
        assert!(!dir.join("stray.mmd").exists());
        assert!(!dir.join("stray.css").exists());
        assert_eq!(fs::read_to_string(dir.join("stray.orei-assets.json")).unwrap(), "external");
    }

    #[test]
    fn create_copy_writes_the_group_without_retaining_an_open_handle() {
        let dir = directory("copy-group");
        let source = dir.join("copy.mmd");
        let registry = PairRegistry::default();
        registry.create_copy(source.clone(), "graph TD\n", "/* copy */\n", Some("{\"assets\":{}}")).unwrap();
        assert_eq!(fs::read_to_string(&source).unwrap(), "graph TD\n");
        assert_eq!(fs::read_to_string(dir.join("copy.css")).unwrap(), "/* copy */\n");
        assert!(registry.entries.is_empty());
        let failure = registry.create_copy(source, "again", "again", None).unwrap_err();
        assert!(failure.contains("already exists"), "{failure}");
        assert_eq!(fs::read_to_string(dir.join("copy.css")).unwrap(), "/* copy */\n");
    }

    #[test]
    fn create_validates_the_destination_name_and_limits_without_writing() {
        let dir = directory("create-validation");
        let mut registry = PairRegistry::default();
        assert!(registry.create(dir.join("not-a-pair.md"), "x", "y", None).unwrap_err().contains(".mmd"));
        let big = "x".repeat(LIMIT as usize + 1);
        assert!(registry.create(dir.join("big.mmd"), &big, "y", None).unwrap_err().contains("8 MiB"));
        assert!(!dir.join("big.mmd").exists());
    }

    #[test]
    fn inspect_reports_changed_members_without_adopting_them() {
        let dir = directory("inspect-changed");
        let source = dir.join("pair.mmd");
        let css = dir.join("pair.css");
        fs::write(&source, "original source").unwrap();
        fs::write(&css, "original css").unwrap();
        let mut registry = PairRegistry::default();
        let opened = registry.authorize(source.clone()).unwrap();
        assert!(!registry.inspect(&opened.handle).unwrap().changed);

        fs::write(&css, "external css").unwrap();
        fs::write(&source, "external source").unwrap();
        let state = registry.inspect(&opened.handle).unwrap();
        assert!(state.changed);
        assert!(state.missing.is_empty());
        assert_eq!(state.source.as_deref(), Some("external source"));
        assert_eq!(state.css.as_deref(), Some("external css"));
        assert_eq!(state.revisions, opened.revisions, "inspect never adopts revisions");
        assert!(state.error.is_none());
        // The expected-revision guard still refuses the write; nothing was adopted.
        let failed = registry.write(&opened.handle, &opened.revisions, "ours", Some("ours"), None).unwrap();
        assert!(failed.failure.is_some());
        assert_eq!(fs::read_to_string(&source).unwrap(), "external source");
        assert_eq!(fs::read_to_string(&css).unwrap(), "external css");
    }

    #[test]
    fn inspect_recognizes_added_and_deleted_companions() {
        let dir = directory("inspect-presence");
        let source = dir.join("pair.mmd");
        fs::write(&source, "graph TD\n").unwrap();
        let mut registry = PairRegistry::default();
        let opened = registry.authorize(source.clone()).unwrap();
        fs::write(dir.join("pair.css"), "external css").unwrap();
        let added = registry.inspect(&opened.handle).unwrap();
        assert!(added.changed);
        assert_eq!(added.css.as_deref(), Some("external css"));
        assert!(added.missing.is_empty());
        assert_eq!(added.revisions.css, None);

        let pair_source = dir.join("both.mmd");
        fs::write(&pair_source, "graph TD\n").unwrap();
        fs::write(dir.join("both.css"), "css").unwrap();
        let both = registry.authorize(pair_source.clone()).unwrap();
        fs::remove_file(dir.join("both.css")).unwrap();
        let removed = registry.inspect(&both.handle).unwrap();
        assert!(removed.changed);
        assert_eq!(removed.css, None);
        assert_eq!(removed.missing, vec!["stylesheet"]);
        assert!(registry.inspect(&opened.handle).unwrap().changed, "an added companion stays visible");
    }

    #[test]
    fn reload_adopts_every_member_and_the_whole_revision_group() {
        let dir = directory("reload-group");
        let source = dir.join("pair.mmd");
        let css = dir.join("pair.css");
        let assets = dir.join("pair.orei-assets.json");
        fs::write(&source, "original source").unwrap();
        fs::write(&css, "original css").unwrap();
        fs::write(&assets, "{\"old\":true}").unwrap();
        let mut registry = PairRegistry::default();
        let opened = registry.authorize(source.clone()).unwrap();
        fs::write(&source, "external source").unwrap();
        fs::write(&css, "external css").unwrap();
        fs::write(&assets, "{\"new\":true}").unwrap();
        let reloaded = registry.reload(&opened.handle).unwrap();
        assert_eq!(reloaded.source, "external source");
        assert_eq!(reloaded.css.as_deref(), Some("external css"));
        assert_eq!(reloaded.assets.as_deref(), Some("{\"new\":true}"));
        assert_eq!(reloaded.revisions, PairRevisions { source: 2, css: Some(2), assets: Some(2) });
        let state = registry.inspect(&opened.handle).unwrap();
        assert!(!state.changed);
        assert!(state.missing.is_empty());
        // The adopted revisions let autosave continue without another conflict.
        let outcome = registry.write(&opened.handle, &reloaded.revisions, "ours", Some("ours"), Some("{}")).unwrap();
        assert!(outcome.failure.is_none());
        assert_eq!(outcome.revisions, PairRevisions { source: 3, css: Some(3), assets: Some(3) });
        assert_eq!(fs::read_to_string(&source).unwrap(), "ours");

        // A companion that disappeared is dropped from the group and recreated exclusively
        // only when a later save includes one.
        fs::remove_file(dir.join("pair.css")).unwrap();
        let after_delete = registry.reload(&opened.handle).unwrap();
        assert_eq!(after_delete.css, None);
        assert_eq!(after_delete.revisions.css, None);
        assert!(fs::read_to_string(&source).unwrap() == "ours");
    }

    #[test]
    fn overwrite_keeps_the_local_group_and_reports_a_partial_write() {
        let dir = directory("overwrite-group");
        let source = dir.join("pair.mmd");
        let css = dir.join("pair.css");
        fs::write(&source, "original source").unwrap();
        fs::write(&css, "original css").unwrap();
        let mut registry = PairRegistry::default();
        let opened = registry.authorize(source.clone()).unwrap();
        fs::write(&source, "external source").unwrap();
        fs::write(&css, "external css").unwrap();
        let compared = ShownGroup { source: Some("external source".into()), css: Some("external css".into()), assets: None };
        let outcome = registry.overwrite(&opened.handle, "kept source", Some("kept css"), None, Some(&compared)).unwrap();
        assert!(outcome.failure.is_none());
        assert_eq!(outcome.written, vec!["source", "stylesheet"]);
        assert_eq!(outcome.revisions, PairRevisions { source: 2, css: Some(2), assets: None });
        assert_eq!(fs::read_to_string(&source).unwrap(), "kept source");
        assert_eq!(fs::read_to_string(&css).unwrap(), "kept css");
        assert!(!registry.inspect(&opened.handle).unwrap().changed);

        // A member that cannot be replaced reports the earlier members that reached disk.
        fs::create_dir(dir.join("pair.orei-assets.json")).unwrap();
        let compared = ShownGroup { source: Some("kept source".into()), css: Some("kept css".into()), assets: None };
        let partial = registry.overwrite(&opened.handle, "newer source", Some("newer css"), Some("{}"), Some(&compared)).unwrap();
        let failure = partial.failure.unwrap();
        assert_eq!(failure.member, "asset index");
        assert_eq!(partial.written, vec!["source", "stylesheet"]);
        assert_eq!(fs::read_to_string(&source).unwrap(), "newer source");
        assert_eq!(fs::read_to_string(&css).unwrap(), "newer css");
        assert!(dir.join("pair.orei-assets.json").is_dir());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn keep_local_preserves_a_member_written_after_the_comparison() {
        let dir = directory("overwrite-late");
        let source = dir.join("pair.mmd");
        let css = dir.join("pair.css");
        fs::write(&source, "original source").unwrap();
        fs::write(&css, "original css").unwrap();
        let mut registry = PairRegistry::default();
        let opened = registry.authorize(source.clone()).unwrap();
        // The dialog compared these versions; an external writer replaced both before the click.
        fs::write(&source, "late source").unwrap();
        fs::write(&css, "late css").unwrap();
        let compared = ShownGroup { source: Some("original source".into()), css: Some("original css".into()), assets: None };
        let outcome = registry.overwrite(&opened.handle, "kept source", Some("kept css"), None, Some(&compared)).unwrap();
        assert!(outcome.failure.is_none());
        assert_eq!(fs::read_to_string(&source).unwrap(), "kept source");
        let members: Vec<&str> = outcome.retained.iter().map(|version| version.member.as_str()).collect();
        assert_eq!(members, vec!["source", "stylesheet"]);
        for version in &outcome.retained {
            let text = version.text.as_deref().unwrap();
            assert!(text.starts_with("late "), "{text}");
            assert_eq!(fs::read_to_string(&version.path).unwrap(), text);
        }
        // Reload Disk puts the preserved members back before adopting the group.
        let reloaded = registry.reload(&opened.handle).unwrap();
        assert_eq!(reloaded.source, "late source");
        assert_eq!(reloaded.css.as_deref(), Some("late css"));
        assert!(registry.inspect(&opened.handle).unwrap().retained.is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn release_restores_displaced_member_versions_and_leaves_substituted_paths_alone() {
        let dir = directory("release");
        let source = dir.join("pair.mmd");
        let css = dir.join("pair.css");
        fs::write(&source, "graph TD\n").unwrap();
        fs::write(&css, "css\n").unwrap();
        let mut registry = PairRegistry::default();
        let opened = registry.authorize(source.clone()).unwrap();
        let (ours, theirs) = (dir.join(".orei-save-ours.tmp"), dir.join(".orei-save-theirs.tmp"));
        fs::write(&ours, "replaced external version").unwrap();
        fs::write(&theirs, "someone else's file").unwrap();
        {
            let entry = registry.entries.get_mut(&opened.handle).unwrap();
            entry.source.force(Some("graph TD\n"), "our source").unwrap();
            let source_css = entry.css.as_mut().unwrap();
            source_css.force(Some("css\n"), "our css").unwrap();
            entry.source.retained = Some(document_io::RetainedContent {
                member: "source".into(), path: ours.clone(), text: Some("replaced external version".into()), ours: "our source".into(),
            });
            entry.css.as_mut().unwrap().retained = Some(document_io::RetainedContent {
                member: "stylesheet".into(), path: theirs.clone(), text: Some("external css".into()), ours: "our css".into(),
            });
        }
        assert!(registry.release(&opened.handle));
        assert_eq!(fs::read_to_string(&source).unwrap(), "replaced external version");
        assert_eq!(fs::read_to_string(&css).unwrap(), "external css");
        assert!(!ours.exists());
        assert_eq!(fs::read_to_string(&theirs).unwrap(), "someone else's file");
        assert!(!registry.release(&opened.handle));
        assert!(registry.inspect(&opened.handle).is_err());
    }

    #[test]
    fn reload_restores_a_displaced_member_before_adopting_the_group() {
        let dir = directory("reload-retained");
        let source = dir.join("pair.mmd");
        fs::write(&source, "graph TD\n").unwrap();
        let mut registry = PairRegistry::default();
        let opened = registry.authorize(source.clone()).unwrap();
        let staged = dir.join(".orei-save-source.tmp");
        fs::write(&staged, "external source").unwrap();
        {
            let entry = registry.entries.get_mut(&opened.handle).unwrap();
            entry.source.force(Some("graph TD\n"), "our source").unwrap();
            entry.source.retained = Some(document_io::RetainedContent {
                member: "source".into(), path: staged.clone(), text: Some("external source".into()), ours: "our source".into(),
            });
        }
        let reloaded = registry.reload(&opened.handle).unwrap();
        assert_eq!(reloaded.source, "external source");
        assert_eq!(fs::read_to_string(&source).unwrap(), "external source");
        assert!(!staged.exists());
        assert!(registry.inspect(&opened.handle).unwrap().retained.is_empty());
    }
}
