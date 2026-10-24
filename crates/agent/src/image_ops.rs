//! Header-only image metadata. Never decode pixels or fetch external resources.
use crate::policy::PathPolicy;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::fs;
use std::io::Read;

const MAX_IMAGE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_HEADER_BYTES: u64 = 256 * 1024;

fn dimensions(bytes: &[u8]) -> Result<(&'static str, &'static str, u32, u32)> {
    if bytes.len() >= 24 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        if &bytes[12..16] != b"IHDR" || bytes[8..12] != [0, 0, 0, 13] {
            return Err(anyhow!("invalid PNG IHDR"));
        }
        let width = u32::from_be_bytes(bytes[16..20].try_into()?);
        let height = u32::from_be_bytes(bytes[20..24].try_into()?);
        return Ok(("PNG", "image/png", width, height));
    }
    if bytes.len() >= 10 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        let width = u16::from_le_bytes(bytes[6..8].try_into()?) as u32;
        let height = u16::from_le_bytes(bytes[8..10].try_into()?) as u32;
        return Ok(("GIF", "image/gif", width, height));
    }
    if bytes.starts_with(&[0xff, 0xd8]) {
        let mut pos = 2_usize;
        while pos < bytes.len() {
            if bytes[pos] != 0xff {
                return Err(anyhow!("invalid JPEG marker"));
            }
            while pos < bytes.len() && bytes[pos] == 0xff {
                pos += 1;
            }
            if pos >= bytes.len() {
                break;
            }
            let marker = bytes[pos];
            pos += 1;
            if marker == 0xd9 || marker == 0xda {
                break;
            }
            if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
                continue;
            }
            if pos + 2 > bytes.len() {
                break;
            }
            let length = u16::from_be_bytes(bytes[pos..pos + 2].try_into()?) as usize;
            if length < 2 || length > bytes.len() - pos {
                break;
            }
            if (0xc0..=0xcf).contains(&marker) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
                if length < 7 {
                    return Err(anyhow!("invalid JPEG frame header"));
                }
                let height = u16::from_be_bytes(bytes[pos + 3..pos + 5].try_into()?) as u32;
                let width = u16::from_be_bytes(bytes[pos + 5..pos + 7].try_into()?) as u32;
                return Ok(("JPEG", "image/jpeg", width, height));
            }
            pos += length;
        }
        return Err(anyhow!("JPEG dimensions not found in first 256 KiB"));
    }
    if bytes.len() >= 30 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        if &bytes[12..16] != b"VP8X" {
            return Err(anyhow!("only extended WebP (VP8X) headers are supported"));
        }
        let width = 1 + u32::from_le_bytes([bytes[24], bytes[25], bytes[26], 0]);
        let height = 1 + u32::from_le_bytes([bytes[27], bytes[28], bytes[29], 0]);
        return Ok(("WEBP", "image/webp", width, height));
    }
    Err(anyhow!("unsupported or invalid image header"))
}

pub fn inspect(policy: &PathPolicy, raw: &str) -> Result<Value> {
    let path = policy.resolve_existing(raw)?;
    if !path.is_file() {
        return Err(anyhow!("image path must refer to a file"));
    }
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") {
        return Err(anyhow!("only PNG, JPEG, GIF and WebP files are supported"));
    }
    let length = fs::metadata(&path)?.len();
    if length == 0 || length > MAX_IMAGE_BYTES {
        return Err(anyhow!("image exceeds the 32 MiB size limit"));
    }
    let mut bytes = Vec::new();
    fs::File::open(&path)?
        .take(MAX_HEADER_BYTES)
        .read_to_end(&mut bytes)?;
    let (format, mime, width, height) = dimensions(&bytes)?;
    let expected = match extension.as_str() {
        "png" => "PNG",
        "jpg" | "jpeg" => "JPEG",
        "gif" => "GIF",
        "webp" => "WEBP",
        _ => unreachable!(),
    };
    if format != expected {
        return Err(anyhow!("image extension does not match its header"));
    }
    if width == 0 || height == 0 || width > 100_000 || height > 100_000 {
        return Err(anyhow!("invalid image dimensions"));
    }
    Ok(json!({
        "path": path.to_string_lossy(),
        "format": format,
        "mimeType": mime,
        "width": width,
        "height": height,
        "fileSizeBytes": length,
        "readOnly": true,
        "pixelsDecoded": false,
        "headerOnly": true
    }))
}

#[cfg(test)]
mod tests {
    use super::dimensions;

    #[test]
    fn png_and_gif_dimensions() {
        let mut png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
        png.extend_from_slice(&2_u32.to_be_bytes());
        png.extend_from_slice(&3_u32.to_be_bytes());
        assert_eq!(dimensions(&png).unwrap().2, 2);
        assert_eq!(dimensions(&png).unwrap().3, 3);
        assert_eq!(dimensions(b"GIF89a\x01\x00\x02\x00").unwrap().3, 2);
    }

    #[test]
    fn reject_truncated_or_invalid_headers() {
        assert!(dimensions(b"\x89PNG\r\n\x1a\n").is_err());
        assert!(dimensions(b"\xff\xd8\xff\xe0\x00\x20").is_err());
        assert!(dimensions(b"GIF89").is_err());
    }
}
