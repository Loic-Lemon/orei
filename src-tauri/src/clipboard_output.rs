//! Validation for the native clipboard commands, mirroring the accepted output limits
//! (`save_output` byte cap, `pngLimits` dimensions) so an oversized or malformed payload
//! is refused before it ever reaches the system pasteboard.

pub const MAX_TEXT_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_SIDE: u32 = 16_384;
pub const MAX_PIXELS: u64 = 64_000_000;

/// SVG markup and Mermaid source travel as plain text: never empty, never past the cap.
pub fn validate_text(text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Err("Nothing to copy: the content is empty".into());
    }
    if text.len() > MAX_TEXT_BYTES {
        return Err("The content is too large for the clipboard".into());
    }
    Ok(())
}

/// A decoded image ready for the pasteboard: 8-bit RGBA pixels with the header's dimensions.
#[derive(Debug)]
pub struct ClipboardImage {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Decodes clipboard image bytes as PNG and enforces the accepted resource limits. The
/// header dimensions are checked before the full decode, so an accepted-size payload
/// claiming absurd dimensions is refused without allocating its pixels.
pub fn decode_image(bytes: &[u8]) -> Result<ClipboardImage, String> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("The image is too large for the clipboard".into());
    }
    if bytes.len() < 8 || bytes[..8] != PNG_SIGNATURE {
        return Err("Expected PNG image bytes for the clipboard".into());
    }
    let (width, height) = image::ImageReader::with_format(
        std::io::Cursor::new(bytes),
        image::ImageFormat::Png,
    )
    .into_dimensions()
    .map_err(|error| format!("Could not read the image: {error}"))?;
    if width == 0 || height == 0 {
        return Err("The image has no pixels".into());
    }
    if width > MAX_SIDE || height > MAX_SIDE {
        return Err("The image exceeds the accepted 16,384 px per side".into());
    }
    if u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err("The image exceeds the accepted 64 million pixels".into());
    }
    let rgba = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .map_err(|error| format!("Could not decode the image: {error}"))?
        .to_rgba8()
        .into_raw();
    if rgba.len() != width as usize * height as usize * 4 {
        return Err("The decoded image does not match its header".into());
    }
    Ok(ClipboardImage { rgba, width, height })
}

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

#[cfg(test)]
mod tests {
    use super::*;

    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbaImage::from_pixel(width, height, image::Rgba([12, 34, 56, 78]));
        let mut out = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut out, image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    /// Builds a PNG header (signature + IHDR) whose payload is never completed, so
    /// dimension limits are exercised without decoding megabytes of pixels.
    fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut crc: u32 = 0xffff_ffff;
        let mut update = |byte: u8| {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                crc = if crc & 1 != 0 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
            }
        };
        let mut chunk = vec![0, 0, 0, 13];
        chunk.extend_from_slice(b"IHDR");
        chunk.extend_from_slice(&width.to_be_bytes());
        chunk.extend_from_slice(&height.to_be_bytes());
        chunk.extend_from_slice(&[8, 6, 0, 0, 0]);
        for byte in &chunk[4..] {
            update(*byte);
        }
        let mut bytes = PNG_SIGNATURE.to_vec();
        bytes.extend_from_slice(&chunk);
        bytes.extend_from_slice(&(!crc).to_be_bytes());
        bytes
    }

    #[test]
    fn the_text_cap_matches_the_save_output_byte_cap() {
        assert_eq!(MAX_TEXT_BYTES, 128 * 1024 * 1024);
    }

    #[test]
    fn text_is_accepted_when_present_and_within_the_cap() {
        assert_eq!(validate_text("flowchart TD\n  A --> B"), Ok(()));
        let limit = "a".repeat(MAX_TEXT_BYTES);
        assert_eq!(validate_text(&limit), Ok(()));
        assert!(validate_text(&(limit + "a")).is_err());
    }

    #[test]
    fn empty_or_oversized_text_is_refused() {
        assert_eq!(validate_text(""), Err("Nothing to copy: the content is empty".into()));
        assert_eq!(validate_text(&"a".repeat(MAX_TEXT_BYTES + 1)), Err("The content is too large for the clipboard".into()));
    }

    #[test]
    fn a_valid_png_decodes_to_rgba_with_its_header_dimensions() {
        let image = decode_image(&png_bytes(3, 2)).unwrap();
        assert_eq!((image.width, image.height), (3, 2));
        assert_eq!(image.rgba.len(), 3 * 2 * 4);
        assert_eq!(&image.rgba[0..4], &[12, 34, 56, 78]);
    }

    #[test]
    fn non_png_and_truncated_bytes_are_refused() {
        assert!(decode_image(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>").is_err());
        assert!(decode_image(&png_bytes(3, 2)[..12]).is_err());
    }

    #[test]
    fn dimension_limits_are_enforced_before_decoding() {
        assert!(decode_image(&png_header(MAX_SIDE + 1, 1)).is_err());
        assert!(decode_image(&png_header(4000, 16_001)).is_err());
    }

    #[test]
    fn dimensions_within_the_limits_pass_the_cap_checks() {
        // At the exact boundary the caps do not reject; the truncated payload fails later.
        let error = decode_image(&png_header(16_384, 3_906)).unwrap_err();
        assert!(!error.contains("16,384") && !error.contains("64 million"));
    }
}
