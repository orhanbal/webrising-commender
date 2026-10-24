//! Bounded, read-only DOCX extraction. Never fetch external relationships or run macros.
use crate::policy::PathPolicy;
use anyhow::{anyhow, Context, Result};
use roxmltree::{Document, Node};
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::PathBuf;

const WORD_NS: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const MAX_DOCX_BYTES: u64 = 16 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DOCUMENT_XML_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 512;
const MAX_PAGE_BYTES: usize = 128 * 1024;

fn is_word(node: Node<'_, '_>, name: &str) -> bool {
    node.is_element()
        && node.tag_name().namespace() == Some(WORD_NS)
        && node.tag_name().name() == name
}

fn checked_docx(policy: &PathPolicy, raw: &str) -> Result<PathBuf> {
    let path = policy.resolve_existing(raw)?;
    if !path.is_file()
        || !path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("docx"))
    {
        return Err(anyhow!("only .docx files are supported"));
    }
    let length = fs::metadata(&path)?.len();
    if length == 0 || length > MAX_DOCX_BYTES {
        return Err(anyhow!("DOCX exceeds the 16 MiB compressed file limit"));
    }
    Ok(path)
}

fn read_xml(policy: &PathPolicy, raw: &str) -> Result<(PathBuf, String)> {
    let path = checked_docx(policy, raw)?;
    let mut archive =
        zip::ZipArchive::new(fs::File::open(&path)?).context("invalid DOCX ZIP archive")?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(anyhow!("DOCX archive contains too many entries"));
    }
    let mut expanded = 0_u64;
    let mut document_count = 0;
    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        expanded = expanded.saturating_add(entry.size());
        if expanded > MAX_EXPANDED_BYTES {
            return Err(anyhow!("DOCX exceeds the 64 MiB expanded archive limit"));
        }
        if entry.name() == "word/document.xml" {
            document_count += 1;
            if entry.size() > MAX_DOCUMENT_XML_BYTES {
                return Err(anyhow!("DOCX document XML exceeds the 8 MiB limit"));
            }
        }
    }
    if document_count != 1 {
        return Err(anyhow!("DOCX must contain exactly one word/document.xml"));
    }
    let mut xml = String::new();
    archive
        .by_name("word/document.xml")?
        .take(MAX_DOCUMENT_XML_BYTES + 1)
        .read_to_string(&mut xml)
        .context("invalid DOCX document XML encoding")?;
    if xml.len() as u64 > MAX_DOCUMENT_XML_BYTES {
        return Err(anyhow!("DOCX document XML exceeds the 8 MiB limit"));
    }
    Ok((path, xml))
}

fn with_body<T>(
    policy: &PathPolicy,
    raw: &str,
    handler: impl FnOnce(PathBuf, Node<'_, '_>) -> Result<T>,
) -> Result<T> {
    let (path, xml) = read_xml(policy, raw)?;
    // roxmltree rejects DTDs by default. No network, relationship or macro loading.
    let document = Document::parse(&xml).context("invalid DOCX WordprocessingML")?;
    let body = document
        .descendants()
        .find(|node| is_word(*node, "body"))
        .ok_or_else(|| anyhow!("DOCX document body not found"))?;
    handler(path, body)
}

fn bounded_text(text: &str, limit: usize) -> (String, bool) {
    if text.len() <= limit {
        return (text.to_owned(), false);
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_owned(), true)
}

fn paragraph_text(paragraph: Node<'_, '_>) -> String {
    let mut text = String::new();
    for node in paragraph.descendants().filter(|node| node.is_element()) {
        if is_word(node, "t") {
            if let Some(value) = node.text() {
                text.push_str(value);
            }
        } else if is_word(node, "tab") {
            text.push('\t');
        } else if is_word(node, "br") || is_word(node, "cr") {
            text.push('\n');
        }
    }
    text
}

pub fn inspect(policy: &PathPolicy, raw: &str) -> Result<Value> {
    with_body(policy, raw, |path, body| {
        let paragraph_count = body
            .descendants()
            .filter(|node| is_word(*node, "p"))
            .count();
        let table_count = body
            .descendants()
            .filter(|node| is_word(*node, "tbl"))
            .count();
        Ok(json!({
            "path": path.to_string_lossy(),
            "paragraphCount": paragraph_count,
            "tableCount": table_count,
            "readOnly": true,
            "macrosExecuted": false,
            "externalResourcesLoaded": false
        }))
    })
}

pub fn read_paragraphs(
    policy: &PathPolicy,
    raw: &str,
    offset: usize,
    limit: usize,
) -> Result<Value> {
    if limit == 0 || limit > 100 || offset > 1_000_000 {
        return Err(anyhow!("invalid DOCX paragraph page (offset <= 1000000, limit 1..100)"));
    }
    with_body(policy, raw, |path, body| {
        let paragraphs: Vec<_> = body
            .descendants()
            .filter(|node| is_word(*node, "p"))
            .collect();
        let mut items = Vec::new();
        let mut bytes = 0_usize;
        for (index, paragraph) in paragraphs.iter().enumerate().skip(offset).take(limit) {
            let full = paragraph_text(*paragraph);
            let (text, text_truncated) = bounded_text(&full, 4096);
            let size = text.len() + 128;
            if bytes.saturating_add(size) > MAX_PAGE_BYTES {
                break;
            }
            bytes += size;
            items.push(json!({
                "index": index,
                "text": text,
                "textTruncated": text_truncated,
                "inTable": paragraph.ancestors().any(|node| is_word(node, "tc"))
            }));
        }
        let next_offset = offset.saturating_add(items.len());
        Ok(json!({
            "path": path.to_string_lossy(),
            "offset": offset,
            "items": items,
            "nextOffset": next_offset,
            "totalParagraphs": paragraphs.len(),
            "hasMore": next_offset < paragraphs.len(),
            "readOnly": true
        }))
    })
}

pub fn read_table(
    policy: &PathPolicy,
    raw: &str,
    table_index: usize,
    offset_rows: usize,
    limit_rows: usize,
) -> Result<Value> {
    if limit_rows == 0 || limit_rows > 50 || offset_rows > 1_000_000 || table_index > 10_000 {
        return Err(anyhow!("invalid DOCX table page"));
    }
    with_body(policy, raw, |path, body| {
        let table = body
            .descendants()
            .filter(|node| is_word(*node, "tbl"))
            .nth(table_index)
            .ok_or_else(|| anyhow!("DOCX table not found"))?;
        let rows: Vec<_> = table
            .children()
            .filter(|node| is_word(*node, "tr"))
            .collect();
        let mut items = Vec::new();
        let mut bytes = 0_usize;
        for (index, row) in rows.iter().enumerate().skip(offset_rows).take(limit_rows) {
            let mut cells = Vec::new();
            for cell in row.children().filter(|node| is_word(*node, "tc")).take(20) {
                let full = cell
                    .descendants()
                    .filter(|node| is_word(*node, "p"))
                    .map(paragraph_text)
                    .collect::<Vec<_>>()
                    .join("\n");
                let (text, truncated) = bounded_text(&full, 2048);
                cells.push(json!({"text": text, "textTruncated": truncated}));
            }
            let size = serde_json::to_vec(&cells)?.len() + 128;
            if bytes.saturating_add(size) > MAX_PAGE_BYTES {
                break;
            }
            bytes += size;
            items.push(json!({"rowIndex": index, "cells": cells}));
        }
        let next_row = offset_rows.saturating_add(items.len());
        Ok(json!({
            "path": path.to_string_lossy(),
            "tableIndex": table_index,
            "totalRows": rows.len(),
            "offsetRows": offset_rows,
            "nextRow": next_row,
            "hasMore": next_row < rows.len(),
            "items": items,
            "readOnly": true
        }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_text_preserves_unicode_boundaries() {
        let (preview, truncated) = bounded_text("çalışma", 3);
        assert_eq!(preview, "ç");
        assert!(truncated);
    }

    #[test]
    fn rejects_unsupported_document_extension() {
        let root = std::env::temp_dir().join(format!("wc-docx-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("not-docx.txt");
        fs::write(&path, b"test").unwrap();
        let policy = PathPolicy::new(vec![root.clone()]).unwrap();
        assert!(inspect(&policy, path.to_str().unwrap()).is_err());
        fs::remove_dir_all(&root).unwrap();
    }
}
