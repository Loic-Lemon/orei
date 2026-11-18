//! Reading a user-picked local PNG for a diagram document.
//!
//! The native picker selects the file; the webview never supplies a path. A document
//! carries the image as a data URL, so a reopen does not depend on the original file.
//! Only PNG is supported, matching the renderer and the paired asset index, and the
//! byte cap keeps the encoded data URL inside the renderer's character limit.
use std::{fs, io::Read, path::Path};

/// Raw bytes allowed for a document image. Base64 expansion (4/3) plus the 22-character
/// `data:image/png;base64,` prefix must stay within the renderer's 2,000,000-character limit:
/// 22 + 4 * ceil(1_499_982 / 3) = 1_999_998 < 2,000,000.
pub const IMAGE_BYTES: u64 = 1_499_982;
pub const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

#[derive(Clone, Debug, serde::Serialize)]
pub struct PickedImage {
    pub name: String,
    pub data: String,
}

/// Reads a picked PNG into a bounded data URL. Extension, file kind, size and the PNG
/// signature are checked before the content reaches the webview.
pub fn read(path: &Path) -> Result<PickedImage, String> {
    if !path.extension().and_then(|s| s.to_str()).is_some_and(|s| s.eq_ignore_ascii_case("png")) {
        return Err("Expected a .png image file".into());
    }
    let name = path.file_name().and_then(|name| name.to_str()).ok_or("Invalid image name")?.to_owned();
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("Expected a regular PNG file".into());
    }
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    if !file.metadata().map_err(|error| error.to_string())?.is_file() {
        return Err("Expected a regular PNG file".into());
    }
    let mut bytes = Vec::new();
    file.take(IMAGE_BYTES + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > IMAGE_BYTES {
        return Err("Image exceeds the 1,499,982-byte import limit".into());
    }
    if !bytes.starts_with(&PNG_SIGNATURE) {
        return Err("Unsupported image content: expected a PNG file".into());
    }
    Ok(PickedImage { name, data: encode(&bytes) })
}

/// Encodes PNG bytes exactly as the renderer and the paired asset index expect them.
pub fn encode(bytes: &[u8]) -> String {
    format!("data:image/png;base64,{}", base64(bytes))
}

pub fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0] as u32;
        let second = chunk.get(1).copied().unwrap_or(0) as u32;
        let third = chunk.get(2).copied().unwrap_or(0) as u32;
        let value = first << 16 | second << 8 | third;
        out.push(TABLE[(value >> 18 & 63) as usize] as char);
        out.push(TABLE[(value >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[(value >> 6 & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(value & 63) as usize] as char } else { '=' });
    }
    out
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
                "orei-image-test-{}-{}",
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

    fn png() -> Vec<u8> {
        let mut bytes = PNG_SIGNATURE.to_vec();
        bytes.extend_from_slice(b"rest of a tiny fixture");
        bytes
    }

    #[test]
    fn reads_a_regular_png_as_a_data_url() {
        let directory = TestDirectory::new();
        let path = directory.0.join("Photo.PNG");
        fs::write(&path, png()).unwrap();
        let picked = read(&path).unwrap();
        assert_eq!(picked.name, "Photo.PNG");
        assert_eq!(picked.data, "data:image/png;base64,iVBORw0KGgpyZXN0IG9mIGEgdGlueSBmaXh0dXJl");
    }

    #[test]
    fn rejects_wrong_extensions_directories_and_non_png_content() {
        let directory = TestDirectory::new();
        let svg = directory.0.join("image.svg");
        fs::write(&svg, "<svg/>").unwrap();
        assert_eq!(read(&svg).unwrap_err(), "Expected a .png image file");
        assert_eq!(read(&directory.0).unwrap_err(), "Expected a .png image file");
        let nested = directory.0.join("png");
        fs::create_dir(&nested).unwrap();
        assert_eq!(read(&nested).unwrap_err(), "Expected a .png image file");
        let text = directory.0.join("fake.png");
        fs::write(&text, "not a png").unwrap();
        assert_eq!(read(&text).unwrap_err(), "Unsupported image content: expected a PNG file");
        assert!(read(&directory.0.join("missing.png")).is_err());
    }

    #[test]
    fn rejects_files_over_the_import_limit_without_reading_past_it() {
        let directory = TestDirectory::new();
        let path = directory.0.join("huge.png");
        let mut bytes = png();
        bytes.resize(IMAGE_BYTES as usize, 0);
        fs::write(&path, &bytes).unwrap();
        let data = read(&path).unwrap().data;
        assert!(data.len() <= 2_000_000, "encoded {} characters", data.len());
        bytes.push(0);
        fs::write(&path, &bytes).unwrap();
        assert!(read(&path).unwrap_err().contains("1,499,982-byte"));
        assert!(fs::metadata(&path).unwrap().len() > IMAGE_BYTES);
    }

    #[test]
    fn base64_matches_known_values() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
