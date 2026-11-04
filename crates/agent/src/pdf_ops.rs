//! Bounded, read-only PDF text extraction (pure Rust, no external renderer).
//! Never runs scripts, follows links or loads external resources.
use crate::policy::PathPolicy;
use anyhow::{anyhow, Result};
use lopdf::{Document, LoadOptions};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

const MAX_PDF_BYTES: u64 = 32 * 1024 * 1024;
const MAX_DECOMPRESSED: usize = 32 * 1024 * 1024;
const MAX_PAGE_TEXT_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_TEXT_BYTES: usize = 256 * 1024;
pub const MAX_PAGES_PER_CALL: u32 = 20;

fn checked_pdf(policy: &PathPolicy, raw: &str) -> Result<PathBuf> {
    let path = policy.resolve_existing(raw)?;
    if !path.is_file()
        || !path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
    {
        return Err(anyhow!("only .pdf files are supported"));
    }
    let length = fs::metadata(&path)?.len();
    if length == 0 || length > MAX_PDF_BYTES {
        return Err(anyhow!("PDF exceeds the 32 MiB file limit"));
    }
    Ok(path)
}

fn bounded(text: &str, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text.to_string(), false);
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

/// Read the text of `count` pages starting at 1-based `start_page`. A negative
/// `start_page` counts from the end (-1 is the last page).
pub fn read(policy: &PathPolicy, raw: &str, start_page: i64, count: u32) -> Result<Value> {
    if count == 0 || count > MAX_PAGES_PER_CALL || start_page == 0 || start_page.abs() > 1_000_000 {
        return Err(anyhow!(
            "invalid PDF page range (start_page 1-based or negative from the end, page_count 1..20)"
        ));
    }
    let path = checked_pdf(policy, raw)?;
    let options = LoadOptions {
        max_decompressed_size: Some(MAX_DECOMPRESSED),
        ..LoadOptions::default()
    };
    let document = Document::load_with_options(&path, options)
        .map_err(|error| anyhow!("unreadable PDF: {error}"))?;
    if document.is_encrypted() && document.encryption_state.is_none() {
        return Err(anyhow!("PDF is encrypted with a password; not supported"));
    }
    let pages = document.get_pages();
    let total = pages.len() as i64;
    let first = if start_page < 0 {
        (total + start_page + 1).max(1)
    } else {
        start_page
    };
    let mut items = Vec::new();
    let mut bytes = 0_usize;
    let mut response_truncated = false;
    let mut page = first;
    while page <= total && page < first + i64::from(count) {
        let number = page as u32;
        let item = match document.extract_text_with_limit(&[number], MAX_DECOMPRESSED) {
            Ok(full) => {
                let (text, truncated) = bounded(full.trim_end(), MAX_PAGE_TEXT_BYTES);
                json!({ "page": number, "text": text, "textTruncated": truncated })
            }
            Err(error) => json!({ "page": number, "text": "", "error": format!("{error}") }),
        };
        let size = item["text"].as_str().map_or(0, str::len) + 64;
        if !items.is_empty() && bytes.saturating_add(size) > MAX_RESPONSE_TEXT_BYTES {
            response_truncated = true;
            break;
        }
        bytes += size;
        items.push(item);
        page += 1;
    }
    let next = first + items.len() as i64;
    Ok(json!({
        "path": path.to_string_lossy(),
        "totalPages": total,
        "startPage": first,
        "pages": items,
        "nextPage": if next <= total { json!(next) } else { Value::Null },
        "hasMore": next <= total,
        "responseTruncated": response_truncated,
        "note": "Text layer only; scanned pages without text return empty text.",
        "readOnly": true
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::content::{Content, Operation};
    use lopdf::{dictionary, Object, Stream};

    fn sample_pdf(pages: &[&str]) -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let font_id = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
        });
        let resources_id = doc.add_object(dictionary! {
            "Font" => dictionary! { "F1" => font_id },
        });
        let mut kids = Vec::new();
        for text in pages {
            let content = Content {
                operations: vec![
                    Operation::new("BT", vec![]),
                    Operation::new("Tf", vec!["F1".into(), 12.into()]),
                    Operation::new("Td", vec![72.into(), 720.into()]),
                    Operation::new("Tj", vec![Object::string_literal(*text)]),
                    Operation::new("ET", vec![]),
                ],
            };
            let content_id = doc.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
            let page_id = doc.add_object(dictionary! {
                "Type" => "Page", "Parent" => pages_id, "Contents" => content_id,
            });
            kids.push(page_id.into());
        }
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Kids" => kids, "Count" => pages.len() as i64,
                "Resources" => resources_id, "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
            }),
        );
        let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", catalog_id);
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    fn fixture(name: &str, bytes: &[u8]) -> (PathBuf, PathPolicy, PathBuf) {
        let root = std::env::temp_dir().join(format!("wc-pdf-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join(name);
        fs::write(&path, bytes).unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        (root, policy, path)
    }

    #[test]
    fn reads_page_ranges_and_negative_offsets() {
        let (root, policy, path) = fixture(
            "doc.pdf",
            &sample_pdf(&["Alpha page", "Beta page", "Gamma page"]),
        );
        let raw = path.to_str().unwrap();
        let all = read(&policy, raw, 1, 20).unwrap();
        assert_eq!(all["totalPages"], 3);
        assert_eq!(all["pages"].as_array().unwrap().len(), 3);
        assert!(all["pages"][1]["text"]
            .as_str()
            .unwrap()
            .contains("Beta page"));
        assert_eq!(all["hasMore"], false);
        let first = read(&policy, raw, 1, 1).unwrap();
        assert_eq!(first["nextPage"], 2);
        assert_eq!(first["hasMore"], true);
        let last = read(&policy, raw, -1, 5).unwrap();
        assert_eq!(last["startPage"], 3);
        assert!(last["pages"][0]["text"].as_str().unwrap().contains("Gamma"));
        assert!(read(&policy, raw, 0, 1).is_err());
        assert!(read(&policy, raw, 1, 21).is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rejects_non_pdf_and_garbage() {
        let (root, policy, path) = fixture("x.txt", b"hello");
        assert!(read(&policy, path.to_str().unwrap(), 1, 1).is_err());
        let garbage = root.join("bad.pdf");
        fs::write(&garbage, b"%PDF-1.4 not really").unwrap();
        assert!(read(&policy, garbage.to_str().unwrap(), 1, 1).is_err());
        let outside = std::env::temp_dir().join("outside.pdf");
        assert!(read(&policy, outside.to_str().unwrap(), 1, 1).is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn bounded_respects_utf8() {
        assert_eq!(bounded("çağ", 2), ("ç".to_string(), true));
        assert_eq!(bounded("ab", 5), ("ab".to_string(), false));
    }
}
