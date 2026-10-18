import * as arrow from 'apache-arrow';
import * as dashql from '@ankoh/dashql-core';

import { arrowValueToJson } from '../../../../../compute/arrow_formatter.js';

/// What to export: a SQL text column and the columns that become metadata
export interface AtlasExportOptions {
    sqlField: number;
    metadataFields: number[];
}

export interface AtlasExportFile {
    name: string;
    text: string;
}

export interface AtlasExport {
    files: AtlasExportFile[];
    /// Rows without SQL text
    skipped: number;
}

/// Formats a cell as it is shown in the table, used for values that JSON cannot represent
export type CellFormatter = (row: number, field: number) => string | null;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/// Turn a cell into a JSON value. Strings, booleans and numbers stay as they are, lists and structs become arrays and
/// objects. Everything else (dates, timestamps, decimals, ...) is written as the table shows it.
/// Returns undefined for nulls, which are left out of the metadata.
export function metadataValue(value: unknown, type: arrow.DataType, formatted: () => string | null): unknown {
    if (value == null) return undefined;
    switch (type.typeId) {
        case arrow.Type.Utf8:
        case arrow.Type.LargeUtf8:
        case arrow.Type.Bool:
            return value;
        case arrow.Type.Int:
        case arrow.Type.Float:
            return jsonNumber(value);
        case arrow.Type.List:
        case arrow.Type.FixedSizeList:
        case arrow.Type.Struct:
        case arrow.Type.Map:
            return jsonSafe(arrowValueToJson(value));
        default:
            return formatted() ?? undefined;
    }
}

/// Numbers that JSON cannot hold exactly are written as strings
function jsonNumber(value: unknown): unknown {
    if (typeof value === 'bigint') {
        const safe = value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER);
        return safe ? Number(value) : value.toString();
    }
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
    return value;
}

function jsonSafe(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(jsonSafe);
    if (value instanceof Date) return value.toISOString();
    if (value != null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
    }
    return jsonNumber(value);
}

/// Files are named after the row of the result, padded so that they sort in row order
export function rowFileName(row: number, rowCount: number): string {
    const digits = Math.max(5, String(rowCount).length);
    return `row_${String(row + 1).padStart(digits, '0')}.sql`;
}

/// Locates the first `@dashql:metadata` block of a script, valid or not, as a UTF-16 range
export type MetadataBlockFinder = (text: string) => { begin: number; end: number } | null;

/// Find metadata blocks with the parser of the core
export function coreMetadataBlockFinder(core: dashql.DashQL): MetadataBlockFinder {
    return (text: string) => {
        if (!text.includes(dashql.METADATA_TAG)) return null;
        const catalog = core.createCatalog();
        const script = core.createScript(catalog);
        try {
            script.insertTextAt(0, text);
            script.parse();
            const parsedPtr = script.getParsed();
            try {
                const parsed = parsedPtr.read();
                const block = new dashql.buffers.parser.CommentBlock();
                for (let i = 0; i < parsed.commentBlocksLength(); ++i) {
                    parsed.commentBlocks(i, block);
                    if (block.blockType() !== dashql.buffers.parser.CommentBlockType.DASHQL_METADATA) continue;
                    const span = block.textSpan()!;
                    // The core reports UTF-8 offsets
                    const bytes = encoder.encode(text);
                    const begin = decoder.decode(bytes.subarray(0, span.offset())).length;
                    const end = begin + decoder.decode(bytes.subarray(span.offset(), span.offset() + span.length())).length;
                    return { begin, end };
                }
                return null;
            } finally {
                parsedPtr.destroy();
            }
        } finally {
            script.destroy();
            catalog.destroy();
        }
    };
}

/// Put the metadata block at the top of a script. An existing metadata block is replaced, everything else stays.
export function applyMetadata(text: string, metadata: dashql.ScriptMetadata, findBlock: MetadataBlockFinder): string {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const existing = findBlock(text);
    let rest = text;
    if (existing != null) {
        // Drop the line break of the old block and the blank line after it
        let end = existing.end;
        for (let i = 0; i < 2; ++i) {
            if (rest.startsWith('\r\n', end)) end += 2;
            else if (rest[end] === '\n') end += 1;
        }
        rest = rest.slice(0, existing.begin) + rest.slice(end);
    }
    return `${dashql.renderMetadataBlock(metadata, eol)}${eol}${eol}${rest}`;
}

/// Build one script per row of the table
export function buildAtlasExport(
    table: arrow.Table,
    options: AtlasExportOptions,
    format: CellFormatter,
    findBlock: MetadataBlockFinder,
): AtlasExport {
    const fields = table.schema.fields;
    const sqlColumn = table.getChildAt(options.sqlField)!;
    const metadataColumns = options.metadataFields.map(f => ({
        field: f,
        name: fields[f].name,
        type: fields[f].type,
        column: table.getChildAt(f)!,
    }));

    const files: AtlasExportFile[] = [];
    let skipped = 0;
    for (let row = 0; row < table.numRows; ++row) {
        const sql = sqlColumn.get(row);
        if (typeof sql !== 'string' || sql.trim().length === 0) {
            ++skipped;
            continue;
        }
        const metadata: dashql.ScriptMetadata = {};
        for (const { field, name, type, column } of metadataColumns) {
            const value = metadataValue(column.get(row), type, () => format(row, field));
            if (value !== undefined) metadata[name] = value;
        }
        files.push({ name: rowFileName(row, table.numRows), text: applyMetadata(sql, metadata, findBlock) });
    }
    return { files, skipped };
}

/// The files of an export that already exist in the folder
export async function existingFiles(directory: FileSystemDirectoryHandle, files: AtlasExportFile[]): Promise<string[]> {
    const existing: string[] = [];
    for (const file of files) {
        try {
            await directory.getFileHandle(file.name);
            existing.push(file.name);
        } catch (e) {
            if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e;
        }
    }
    return existing;
}

/// Write the files into the folder, existing files are overwritten
export async function writeAtlasExport(
    directory: FileSystemDirectoryHandle,
    files: AtlasExportFile[],
    onProgress?: (done: number, total: number) => void,
): Promise<void> {
    for (let i = 0; i < files.length; ++i) {
        const handle = await directory.getFileHandle(files[i].name, { create: true });
        const writable = await handle.createWritable();
        try {
            await writable.write(files[i].text);
        } finally {
            await writable.close();
        }
        onProgress?.(i + 1, files.length);
    }
}
