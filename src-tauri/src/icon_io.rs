use std::{fs, io::Read, path::Path};

/// Matches the frontend icon-file guard (ICON_FILE_LIMIT characters). A byte cap
/// here is never looser than the character cap for UTF-8 input.
pub const LIMIT: u64 = 512 * 1024;
/// Matches the frontend collection guard (COLLECTION_TEXT_LIMIT characters).
pub const COLLECTION_LIMIT: u64 = 2 * 1024 * 1024;

#[derive(Clone, Debug, serde::Serialize)]
pub struct PickedIcon { pub name: String, pub text: String }

/// Read a picked SVG for the document icon library. The extension, file kind,
/// encoding and size are checked before the content reaches the renderer.
pub fn read(path: &Path) -> Result<String, String> {
    read_bounded(path, "svg", LIMIT, "Expected an .svg icon file", "Expected a regular SVG file", "Icon exceeds the 512 KiB import limit", "Icon is not UTF-8 text")
}

/// Read a picked Iconify JSON collection. The renderer validates its structure and
/// definitions; this seam only bounds the bytes and requires a regular UTF-8 file.
pub fn read_collection(path: &Path) -> Result<String, String> {
    read_bounded(
        path,
        "json",
        COLLECTION_LIMIT,
        "Expected an .json Iconify collection file",
        "Expected a regular collection file",
        "Icon collection exceeds the 2048 KiB import limit",
        "Icon collection is not UTF-8 text",
    )
}

fn read_bounded(path: &Path, extension: &str, limit: u64, wrong_extension: &str, not_regular: &str, too_large: &str, not_utf8: &str) -> Result<String, String> {
    if !path.extension().and_then(|s| s.to_str()).is_some_and(|s| s.eq_ignore_ascii_case(extension)) {
        return Err(wrong_extension.into());
    }
    if !fs::metadata(path).map_err(|e| e.to_string())?.is_file() {
        return Err(not_regular.into());
    }
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err(not_regular.into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err(too_large.into());
    }
    String::from_utf8(bytes).map_err(|_| not_utf8.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "orei-icon-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn reads_a_regular_svg_verbatim() {
        let directory = TestDirectory::new();
        let path = directory.0.join("car.SVG");
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"/>";
        fs::write(&path, svg).unwrap();
        assert_eq!(read(&path).unwrap(), svg);
    }

    #[test]
    fn rejects_wrong_extension_directories_and_non_utf8() {
        let directory = TestDirectory::new();
        let text = directory.0.join("car.png");
        fs::write(&text, "<svg/>").unwrap();
        assert_eq!(read(&text).unwrap_err(), "Expected an .svg icon file");
        assert_eq!(read(&directory.0).unwrap_err(), "Expected an .svg icon file");
        let nested = directory.0.join("svg");
        fs::create_dir(&nested).unwrap();
        assert_eq!(read(&nested).unwrap_err(), "Expected an .svg icon file");
        let binary = directory.0.join("binary.svg");
        fs::write(&binary, [0xff, 0xfe]).unwrap();
        assert_eq!(read(&binary).unwrap_err(), "Icon is not UTF-8 text");
    }

    #[test]
    fn rejects_files_over_the_import_limit_without_reading_past_it() {
        let directory = TestDirectory::new();
        let path = directory.0.join("huge.svg");
        fs::write(&path, " ".repeat(LIMIT as usize)).unwrap();
        assert!(read(&path).unwrap().len() as u64 == LIMIT);
        fs::write(&path, " ".repeat(LIMIT as usize + 1)).unwrap();
        assert!(read(&path).unwrap_err().contains("512 KiB"));
        assert!(fs::metadata(&path).unwrap().len() > LIMIT);
    }

    #[test]
    fn reads_a_regular_collection_verbatim() {
        let directory = TestDirectory::new();
        let path = directory.0.join("acme.JSON");
        let collection = "{\"prefix\":\"acme\",\"icons\":{}}";
        fs::write(&path, collection).unwrap();
        assert_eq!(read_collection(&path).unwrap(), collection);
    }

    #[test]
    fn rejects_collections_with_the_wrong_extension_or_unreadable_text() {
        let directory = TestDirectory::new();
        let svg = directory.0.join("icons.svg");
        fs::write(&svg, "{}").unwrap();
        assert_eq!(read_collection(&svg).unwrap_err(), "Expected an .json Iconify collection file");
        let binary = directory.0.join("icons.json");
        fs::write(&binary, [0xff, 0xfe]).unwrap();
        assert_eq!(read_collection(&binary).unwrap_err(), "Icon collection is not UTF-8 text");
        let nested = directory.0.join("json");
        fs::create_dir(&nested).unwrap();
        assert_eq!(read_collection(&nested).unwrap_err(), "Expected an .json Iconify collection file");
        assert_eq!(read_collection(&directory.0).unwrap_err(), "Expected an .json Iconify collection file");
    }

    #[test]
    fn rejects_collections_over_the_two_mebibyte_limit() {
        let directory = TestDirectory::new();
        let path = directory.0.join("huge.json");
        fs::write(&path, " ".repeat(COLLECTION_LIMIT as usize)).unwrap();
        assert_eq!(read_collection(&path).unwrap().len() as u64, COLLECTION_LIMIT);
        fs::write(&path, " ".repeat(COLLECTION_LIMIT as usize + 1)).unwrap();
        assert!(read_collection(&path).unwrap_err().contains("2048 KiB"));
        assert!(fs::metadata(&path).unwrap().len() > COLLECTION_LIMIT);
    }
}
