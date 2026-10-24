//! Bounded, read-only spreadsheet inspection. Never execute macros or formulas.
use crate::policy::PathPolicy;
use anyhow::{anyhow, Context, Result};
use calamine::{open_workbook_auto, Data, Reader};
use serde_json::{json, Value};
use std::fs;

const MAX_WORKBOOK_BYTES: u64 = 16 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 512;
const MAX_ROWS: u32 = 50;
const MAX_COLS: u32 = 20;
const MAX_CELL_PAGE_JSON_BYTES: usize = 256 * 1024;
const MAX_SEARCHED_CELLS: usize = 50_000;
const MAX_SEARCH_RESULTS: usize = 100;

fn checked_workbook(policy: &PathPolicy, raw: &str) -> Result<std::path::PathBuf> {
    let path = policy.resolve_existing(raw)?;
    if !path.is_file() {
        return Err(anyhow!("spreadsheet path is not a file"));
    }
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default();
    if !ext.eq_ignore_ascii_case("xlsx") && !ext.eq_ignore_ascii_case("xlsm") {
        return Err(anyhow!("only .xlsx and .xlsm spreadsheets are supported"));
    }
    let len = fs::metadata(&path)?.len();
    if len == 0 || len > MAX_WORKBOOK_BYTES {
        return Err(anyhow!(
            "spreadsheet exceeds the 16 MiB compressed file limit"
        ));
    }
    // ZIP metadata inspection prevents unbounded decompression by the reader.
    // Reading an XLSM never executes its embedded VBA code.
    let file = fs::File::open(&path)?;
    let mut archive = zip::ZipArchive::new(file).context("invalid spreadsheet ZIP archive")?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(anyhow!("spreadsheet archive contains too many entries"));
    }
    let mut expanded = 0_u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        expanded = expanded.saturating_add(entry.size());
        if expanded > MAX_UNCOMPRESSED_BYTES {
            return Err(anyhow!(
                "spreadsheet exceeds the 64 MiB expanded archive limit"
            ));
        }
    }
    Ok(path)
}

pub fn inspect(policy: &PathPolicy, raw: &str) -> Result<Value> {
    let path = checked_workbook(policy, raw)?;
    let workbook = open_workbook_auto(&path).context("cannot parse spreadsheet")?;
    let sheets = workbook.sheet_names();
    Ok(json!({
        "path": path.to_string_lossy(),
        "sheets": sheets,
        "sheetCount": sheets.len(),
        "readOnly": true,
        "macrosExecuted": false,
        "maxRowsPerPage": MAX_ROWS,
        "maxColumnsPerPage": MAX_COLS
    }))
}

pub fn read_range(
    policy: &PathPolicy,
    raw: &str,
    sheet: &str,
    start_row: u32,
    start_col: u32,
    row_count: u32,
    col_count: u32,
) -> Result<Value> {
    if sheet.is_empty() || sheet.len() > 255 {
        return Err(anyhow!("invalid sheet name"));
    }
    if start_row == 0
        || start_col == 0
        || row_count == 0
        || col_count == 0
        || row_count > MAX_ROWS
        || col_count > MAX_COLS
        || start_row.saturating_add(row_count - 1) > 1_048_576
        || start_col.saturating_add(col_count - 1) > 16_384
    {
        return Err(anyhow!(
            "invalid spreadsheet range (1-based coordinates, maximum 50x20)"
        ));
    }
    let path = checked_workbook(policy, raw)?;
    let mut workbook = open_workbook_auto(&path).context("cannot parse spreadsheet")?;
    if !workbook.sheet_names().iter().any(|name| name == sheet) {
        return Err(anyhow!("spreadsheet sheet not found"));
    }
    let range = workbook
        .worksheet_range(sheet)
        .context("cannot read spreadsheet sheet")?;
    let mut cells = Vec::new();
    let mut used_bytes = 0_usize;
    let mut truncated = false;
    'rows: for row in start_row..start_row + row_count {
        for column in start_col..start_col + col_count {
            if let Some(data) = range.get_value((row - 1, column - 1)) {
                if !matches!(data, Data::Empty) {
                    let item = json!({
                        "row": row,
                        "column": column,
                        "data": cell_value(data)
                    });
                    let size = serde_json::to_vec(&item)?.len();
                    if used_bytes.saturating_add(size) > MAX_CELL_PAGE_JSON_BYTES {
                        truncated = true;
                        break 'rows;
                    }
                    used_bytes += size;
                    cells.push(item);
                }
            }
        }
    }
    Ok(json!({
        "path": path.to_string_lossy(),
        "sheet": sheet,
        "startRow": start_row,
        "startColumn": start_col,
        "rowCount": row_count,
        "columnCount": col_count,
        "cells": cells,
        "truncated": truncated,
        "maxPageJsonBytes": MAX_CELL_PAGE_JSON_BYTES,
        "readOnly": true
    }))
}

/// Search cached spreadsheet values without evaluating formulas or macros.
pub fn find_cells(
    policy: &PathPolicy,
    raw: &str,
    sheet: Option<&str>,
    query: &str,
    case_sensitive: bool,
    max_results: usize,
) -> Result<Value> {
    if query.is_empty()
        || query.len() > 1024
        || max_results == 0
        || max_results > MAX_SEARCH_RESULTS
    {
        return Err(anyhow!("invalid spreadsheet search parameters"));
    }
    let path = checked_workbook(policy, raw)?;
    let mut workbook = open_workbook_auto(&path).context("cannot parse spreadsheet")?;
    let sheets = match sheet {
        Some(name) => {
            if !workbook
                .sheet_names()
                .iter()
                .any(|candidate| candidate == name)
            {
                return Err(anyhow!("spreadsheet sheet not found"));
            }
            vec![name.to_owned()]
        }
        None => workbook.sheet_names(),
    };
    let needle = if case_sensitive {
        query.to_owned()
    } else {
        query.to_lowercase()
    };
    let mut scanned = 0_usize;
    let mut matches = Vec::new();
    let mut truncated = false;
    'sheets: for name in sheets.iter().take(30) {
        let range = workbook.worksheet_range(name)?;
        let (first_row, first_col) = range.start().unwrap_or((0, 0));
        for (row, col, value) in range.used_cells() {
            scanned += 1;
            if scanned > MAX_SEARCHED_CELLS {
                truncated = true;
                break 'sheets;
            }
            let display = value.to_string();
            let found = if case_sensitive {
                display.contains(&needle)
            } else {
                display.to_lowercase().contains(&needle)
            };
            if found {
                matches.push(json!({
                    "sheet": name,
                    "row": first_row + row as u32 + 1,
                    "column": first_col + col as u32 + 1,
                    "value": display
                }));
                if matches.len() >= max_results {
                    truncated = true;
                    break 'sheets;
                }
            }
        }
    }
    if sheets.len() > 30 {
        truncated = true;
    }
    Ok(json!({
        "path": path.to_string_lossy(),
        "items": matches,
        "scannedCells": scanned.min(MAX_SEARCHED_CELLS),
        "truncated": truncated,
        "readOnly": true
    }))
}

/// Write into a new .xlsx file, never overwrite the source or an existing output.
/// XLSM writing is intentionally excluded until macro-preservation is verified.
pub fn write_cells(
    policy: &PathPolicy,
    raw: &str,
    output_raw: &str,
    sheet: &str,
    updates: &[crate::protocol::SpreadsheetCellUpdate],
    expected_sha256: Option<&str>,
) -> Result<Value> {
    use sha2::{Digest, Sha256};
    use std::collections::HashSet;

    if updates.is_empty() || updates.len() > 100 {
        return Err(anyhow!("cell update count must be between 1 and 100"));
    }
    if sheet.is_empty() || sheet.len() > 255 {
        return Err(anyhow!("invalid sheet name"));
    }
    let source = checked_workbook(policy, raw)?;
    if !source
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .eq_ignore_ascii_case("xlsx")
    {
        return Err(anyhow!("macro-enabled XLSM workbooks are read-only"));
    }
    let output = policy.resolve_for_create(output_raw)?;
    if !output
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .eq_ignore_ascii_case("xlsx")
    {
        return Err(anyhow!("output must be a new .xlsx file"));
    }
    if output == source || output.exists() {
        return Err(anyhow!("output must not overwrite an existing file"));
    }
    let parent = output
        .parent()
        .ok_or_else(|| anyhow!("missing output parent"))?;
    if !parent.is_dir() {
        return Err(anyhow!("output parent directory does not exist"));
    }

    let mut seen = HashSet::new();
    for update in updates {
        validate_cell_address(&update.cell)?;
        if !seen.insert(update.cell.as_str()) {
            return Err(anyhow!("duplicate spreadsheet cell address"));
        }
        match &update.value {
            Value::String(v) if v.len() <= 8192 => {}
            Value::Bool(_) => {}
            Value::Number(n) if n.as_f64().is_some_and(f64::is_finite) => {}
            _ => {
                return Err(anyhow!(
                    "cell value must be a string <=8192 bytes, finite number, or boolean"
                ))
            }
        }
    }

    let original = fs::read(&source)?;
    let previous_sha256 = format!("{:x}", Sha256::digest(&original));
    if let Some(expected) = expected_sha256 {
        if !previous_sha256.eq_ignore_ascii_case(expected) {
            return Err(anyhow!("file_changed_since_read"));
        }
    }
    reject_complex_edit_parts(&source)?;
    let mut book = umya_spreadsheet::reader::xlsx::read(&source)
        .map_err(|error| anyhow!("cannot read XLSX for editing: {error}"))?;
    let worksheet = book
        .get_sheet_by_name_mut(sheet)
        .ok_or_else(|| anyhow!("spreadsheet sheet not found"))?;
    for update in updates {
        let cell = worksheet.get_cell_mut(update.cell.as_str());
        match &update.value {
            Value::String(v) => {
                cell.set_value_string(v);
            }
            Value::Bool(v) => {
                cell.set_value_bool(*v);
            }
            Value::Number(v) => {
                cell.set_value_number(
                    v.as_f64()
                        .ok_or_else(|| anyhow!("invalid numeric cell value"))?,
                );
            }
            _ => return Err(anyhow!("unsupported cell value")),
        }
    }

    // Re-check the source after parsing to reject concurrent edits before publication.
    if format!("{:x}", Sha256::digest(fs::read(&source)?)) != previous_sha256 {
        return Err(anyhow!("file_changed_since_read"));
    }
    let temporary = parent.join(format!(".wecommander-{}.xlsx", uuid::Uuid::new_v4()));
    let result = (|| -> Result<Value> {
        umya_spreadsheet::writer::xlsx::write(&book, &temporary)
            .map_err(|error| anyhow!("cannot save XLSX: {error}"))?;
        checked_workbook(
            policy,
            temporary
                .to_str()
                .ok_or_else(|| anyhow!("invalid temporary path"))?,
        )?;
        // Publish without replacement: hard_link is atomic and fails if a
        // concurrent writer has already created the output path.
        fs::File::open(&temporary)?.sync_all()?;
        let output_bytes = fs::read(&temporary)?;
        fs::hard_link(&temporary, &output).context("atomic output publish failed")?;
        Ok(json!({
            "ok": true,
            "path": output.to_string_lossy(),
            "sourcePath": source.to_string_lossy(),
            "updatedCells": updates.len(),
            "previousSha256": previous_sha256,
            "sha256": format!("{:x}", Sha256::digest(&output_bytes)),
            "size": output_bytes.len()
        }))
    })();
    let _ = fs::remove_file(&temporary);
    result
}

// Complex OOXML features are not reliably preserved by every XLSX writer.
// Fail closed instead of silently deleting pivot caches, charts or signatures.
fn reject_complex_edit_parts(path: &std::path::Path) -> Result<()> {
    let mut archive = zip::ZipArchive::new(fs::File::open(path)?)?;
    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        let name = entry.name().to_ascii_lowercase();
        if is_unsafe_edit_part(&name) {
            return Err(anyhow!(
                "complex workbook features require read-only access"
            ));
        }
    }
    Ok(())
}

fn is_unsafe_edit_part(name: &str) -> bool {
    name.starts_with("xl/pivot")
        || name.starts_with("xl/charts/")
        || name.starts_with("xl/drawings/")
        || name.starts_with("xl/externallinks/")
        || name.starts_with("xl/embeddings/")
        || name.starts_with("xl/media/")
        || name.starts_with("_xmlsignatures/")
        || name == "xl/calcchain.xml"
        || name == "xl/vbaproject.bin"
}

fn validate_cell_address(cell: &str) -> Result<()> {
    let split = cell
        .bytes()
        .position(|byte| byte.is_ascii_digit())
        .ok_or_else(|| anyhow!("invalid cell address"))?;
    let (letters, digits) = cell.split_at(split);
    if letters.is_empty()
        || letters.len() > 3
        || !letters.bytes().all(|byte| byte.is_ascii_uppercase())
        || digits.is_empty()
        || digits.starts_with('0')
        || !digits.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(anyhow!("invalid cell address"));
    }
    let mut column = 0_u32;
    for byte in letters.bytes() {
        column = column * 26 + u32::from(byte - b'A' + 1);
    }
    let row: u32 = digits.parse().context("invalid cell row")?;
    if column > 16_384 || row == 0 || row > 1_048_576 {
        return Err(anyhow!("cell address outside XLSX bounds"));
    }
    Ok(())
}

fn cell_value(value: &Data) -> Value {
    match value {
        Data::Empty => Value::Null,
        Data::String(v) => json!({"type":"string","value":v}),
        Data::Int(v) => json!({"type":"number","value":v}),
        Data::Float(v) => json!({"type":"number","value":v}),
        Data::Bool(v) => json!({"type":"boolean","value":v}),
        Data::Error(v) => json!({"type":"error","value":v.to_string()}),
        Data::DateTime(v) => json!({"type":"datetime","value":v.to_string()}),
        Data::DateTimeIso(v) => json!({"type":"datetime","value":v}),
        Data::DurationIso(v) => json!({"type":"duration","value":v}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn range_rejects_invalid_coordinates_before_opening() {
        let policy = PathPolicy::new(&[std::env::temp_dir()]).unwrap();
        assert!(read_range(&policy, "not-found.xlsx", "Sample", 0, 1, 1, 1).is_err());
        assert!(read_range(&policy, "not-found.xlsx", "Sample", 1, 1, 51, 1).is_err());
        assert!(read_range(&policy, "not-found.xlsx", "Sample", 1, 1, 1, 21).is_err());
        assert!(read_range(&policy, "not-found.xlsx", "Sample", 1_048_576, 1, 2, 1).is_err());
        assert!(read_range(&policy, "not-found.xlsx", "Sample", 1, 16_384, 1, 2).is_err());
    }

    #[test]
    fn complex_workbook_parts_are_not_silently_dropped() {
        assert!(is_unsafe_edit_part("xl/pivottables/pivottable1.xml"));
        assert!(is_unsafe_edit_part("xl/charts/chart1.xml"));
        assert!(is_unsafe_edit_part("xl/drawings/drawing1.xml"));
        assert!(is_unsafe_edit_part("xl/externallinks/externallink1.xml"));
        assert!(is_unsafe_edit_part("xl/calcchain.xml"));
        assert!(is_unsafe_edit_part("xl/vbaproject.bin"));
        assert!(!is_unsafe_edit_part("xl/styles.xml"));
        assert!(!is_unsafe_edit_part("xl/worksheets/sheet1.xml"));
    }

    #[test]
    fn cell_address_validation_checks_excel_bounds() {
        assert!(validate_cell_address("A1").is_ok());
        assert!(validate_cell_address("XFD1048576").is_ok());
        for cell in ["A0", "A01", "a1", "XFE1", "A1048577", "ZZZZ1", "A", "1A"] {
            assert!(validate_cell_address(cell).is_err(), "{cell}");
        }
    }

    #[test]
    fn non_spreadsheet_is_rejected() {
        let root = std::env::temp_dir().join(format!("commander-xlsx-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let file = root.join("test.txt");
        fs::write(&file, b"not an Excel workbook").unwrap();
        assert!(inspect(&policy, file.to_str().unwrap()).is_err());
        assert!(inspect(
            &policy,
            PathBuf::from(&root).join("missing.xlsx").to_str().unwrap()
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
