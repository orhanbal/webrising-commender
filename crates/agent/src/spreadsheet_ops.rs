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

fn checked_workbook(policy: &PathPolicy, raw: &str) -> Result<std::path::PathBuf> {
    let path = policy.resolve_existing(raw)?;
    if !path.is_file() {
        return Err(anyhow!("spreadsheet path is not a file"));
    }
    let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or_default();
    if !ext.eq_ignore_ascii_case("xlsx") && !ext.eq_ignore_ascii_case("xlsm") {
        return Err(anyhow!("only .xlsx and .xlsm spreadsheets are supported"));
    }
    let len = fs::metadata(&path)?.len();
    if len == 0 || len > MAX_WORKBOOK_BYTES {
        return Err(anyhow!("spreadsheet exceeds the 16 MiB compressed file limit"));
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
            return Err(anyhow!("spreadsheet exceeds the 64 MiB expanded archive limit"));
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
    if start_row == 0 || start_col == 0 || row_count == 0 || col_count == 0 ||
        row_count > MAX_ROWS || col_count > MAX_COLS ||
        start_row.saturating_add(row_count - 1) > 1_048_576 ||
        start_col.saturating_add(col_count - 1) > 16_384 {
        return Err(anyhow!("invalid spreadsheet range (1-based coordinates, maximum 50x20)"));
    }
    let path = checked_workbook(policy, raw)?;
    let mut workbook = open_workbook_auto(&path).context("cannot parse spreadsheet")?;
    if !workbook.sheet_names().iter().any(|name| name == sheet) {
        return Err(anyhow!("spreadsheet sheet not found"));
    }
    let range = workbook.worksheet_range(sheet).context("cannot read spreadsheet sheet")?;
    let mut cells = Vec::new();
    for row in start_row..start_row + row_count {
        for column in start_col..start_col + col_count {
            if let Some(data) = range.get_value((row - 1, column - 1)) {
                if !matches!(data, Data::Empty) {
                    cells.push(json!({
                        "row": row,
                        "column": column,
                        "data": cell_value(data)
                    }));
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
        "readOnly": true
    }))
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
    fn non_spreadsheet_is_rejected() {
        let root = std::env::temp_dir().join(format!("commander-xlsx-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let policy = PathPolicy::new(std::slice::from_ref(&root)).unwrap();
        let file = root.join("test.txt");
        fs::write(&file, b"not an Excel workbook").unwrap();
        assert!(inspect(&policy, file.to_str().unwrap()).is_err());
        assert!(inspect(&policy, PathBuf::from(&root).join("missing.xlsx").to_str().unwrap()).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
