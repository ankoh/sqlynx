import * as arrow from 'apache-arrow';

import type { CommentRow, FeatureRow } from './rows.js';

/// Number of coordinates per row in the features and the comments file
export const LAYOUT_DIMS = 3;
/// Both files have their own layout and name its columns after what the embeddings are about: the comments say what a
/// script is about (description), the features describe the shape of its queries.
export const LAYOUT_COLUMNS = {
    features: ['atlas_features_3d_x', 'atlas_features_3d_y', 'atlas_features_3d_z'],
    comments: ['atlas_description_3d_x', 'atlas_description_3d_y', 'atlas_description_3d_z'],
} as const;

const utf8 = new arrow.Utf8();
const int32 = new arrow.Int32();
const bool = new arrow.Bool();
/// The tables are only a staging area for Hyper: persistent tables of the compute database do not support 32-bit floats,
/// so floats travel as doubles and are cast back to real when the Parquet files are written (see `exportSelect`).
const float64 = new arrow.Float64();
const utf8List = new arrow.List(new arrow.Field('item', new arrow.Utf8(), true));
const embeddingType = new arrow.List(new arrow.Field('item', new arrow.Float64(), false));

type Column = [name: string, type: arrow.DataType, data: arrow.Data];

/// Columns are assembled from buffers. arrow.vectorFromArray goes through the Arrow builders, which compile their null
/// checks with `new Function`, and the CSP of the page does not allow that.
const encoder = new TextEncoder();

function utf8Data(values: string[]): arrow.Data<arrow.Utf8> {
    const encoded = values.map(v => encoder.encode(v));
    const offsets = new Int32Array(values.length + 1);
    let total = 0;
    encoded.forEach((bytes, i) => {
        offsets[i] = total;
        total += bytes.length;
    });
    offsets[values.length] = total;
    const data = new Uint8Array(total);
    encoded.forEach((bytes, i) => data.set(bytes, offsets[i]));
    return arrow.makeData({ type: utf8, length: values.length, nullCount: 0, valueOffsets: offsets, data });
}

function boolData(values: boolean[]): arrow.Data<arrow.Bool> {
    const data = new Uint8Array(Math.ceil(values.length / 8));
    values.forEach((v, i) => {
        if (v) data[i >> 3] |= 1 << (i & 7);
    });
    return arrow.makeData({ type: bool, length: values.length, nullCount: 0, data });
}

function utf8ListData(rows: string[][]): arrow.Data<arrow.List<arrow.Utf8>> {
    const offsets = new Int32Array(rows.length + 1);
    rows.forEach((row, i) => {
        offsets[i + 1] = offsets[i] + row.length;
    });
    return arrow.makeData({
        type: utf8List,
        length: rows.length,
        nullCount: 0,
        valueOffsets: offsets,
        child: utf8Data(rows.flat()),
    });
}

function column(values: unknown[], type: arrow.DataType): arrow.Data {
    switch (type.typeId) {
        case arrow.Type.Utf8:
            return utf8Data(values as string[]);
        case arrow.Type.Bool:
            return boolData(values as boolean[]);
        case arrow.Type.Int:
            return arrow.makeData({ type: int32, length: values.length, nullCount: 0, data: Int32Array.from(values as number[]) });
        case arrow.Type.Float:
            return arrow.makeData({ type: float64, length: values.length, nullCount: 0, data: Float64Array.from(values as number[]) });
        case arrow.Type.List:
            return utf8ListData(values as string[][]);
        default:
            throw new Error(`cannot build a column of type ${type}`);
    }
}

/// The embeddings as a List<Float64> column. Hyper reads and writes Parquet vectors as variable-size float arrays, which
/// is what the vector functions of the engine accept.
function embeddingColumn(vectors: Float32Array[], dim: number): arrow.Data<arrow.List<arrow.Float64>> {
    const flat = new Float64Array(vectors.length * dim);
    const offsets = new Int32Array(vectors.length + 1);
    vectors.forEach((v, i) => {
        if (v.length !== dim) throw new Error(`embedding ${i} has dimension ${v.length}, expected ${dim}`);
        flat.set(v, i * dim);
        offsets[i + 1] = (i + 1) * dim;
    });
    return arrow.makeData({
        type: embeddingType,
        length: vectors.length,
        nullCount: 0,
        valueOffsets: offsets,
        child: arrow.makeData({ type: float64, length: flat.length, data: flat }),
    });
}

function buildTable(columns: Column[], length: number): arrow.Table {
    const fields = columns.map(([name, type]) => new arrow.Field(name, type, false));
    const struct = arrow.makeData({
        type: new arrow.Struct(fields),
        length,
        nullCount: 0,
        children: columns.map(([, , data]) => data),
    });
    return new arrow.Table([new arrow.RecordBatch(new arrow.Schema(fields), struct)]);
}

/// The layout columns of `rows` rows, `coords` holds LAYOUT_DIMS values per row
function layoutColumns(kind: keyof typeof LAYOUT_COLUMNS, rows: number, coords: Float32Array): Column[] {
    if (coords.length !== rows * LAYOUT_DIMS) {
        throw new Error(`expected ${rows * LAYOUT_DIMS} layout values, got ${coords.length}`);
    }
    return LAYOUT_COLUMNS[kind].map((name, d) => [
        name,
        float64,
        column(Array.from({ length: rows }, (_, i) => coords[i * LAYOUT_DIMS + d]), float64),
    ]);
}

/// `coords` holds LAYOUT_DIMS values per row
export function commentsTable(rows: CommentRow[], dim: number, coords: Float32Array): arrow.Table {
    return buildTable(
        [
            ['script_name', utf8, column(rows.map(r => r.scriptName), utf8)],
            ['script_hash', utf8, column(rows.map(r => r.scriptHash), utf8)],
            ['chunk_index', int32, column(rows.map(r => r.chunkIndex), int32)],
            ['source', utf8, column(rows.map(r => r.source), utf8)],
            ['text', utf8, column(rows.map(r => r.text), utf8)],
            ['embedding', embeddingType, embeddingColumn(rows.map(r => r.embedding), dim)],
            ...layoutColumns('comments', rows.length, coords),
        ],
        rows.length,
    );
}

/// The feature text and the script are not stored, both can be recomputed from the SQL files.
/// `coords` holds LAYOUT_DIMS values per row.
export function featuresTable(rows: FeatureRow[], dim: number, coords: Float32Array): arrow.Table {
    const list = (pick: (r: FeatureRow) => string[]): arrow.Data => column(rows.map(pick), utf8List);
    return buildTable(
        [
            ['script_name', utf8, column(rows.map(r => r.scriptName), utf8)],
            ['script_hash', utf8, column(rows.map(r => r.scriptHash), utf8)],
            ['truncated', bool, column(rows.map(r => r.truncated), bool)],
            ['embedding', embeddingType, embeddingColumn(rows.map(r => r.embedding), dim)],
            ...layoutColumns('features', rows.length, coords),
            ['statement_types', utf8List, list(r => r.features.statementTypes)],
            ['tables', utf8List, list(r => r.features.tables)],
            ['columns', utf8List, list(r => r.features.columns)],
            ['functions', utf8List, list(r => r.features.functions)],
            ['aggregates', utf8List, list(r => r.features.aggregates)],
            ['function_calls', utf8List, list(r => r.features.functionCalls)],
            ['ctes', utf8List, list(r => r.features.ctes)],
            ['joins', utf8List, list(r => r.features.joins)],
            ['filters', utf8List, list(r => r.features.filters)],
            ['operators', utf8List, list(r => r.features.operators)],
            ['visualizations', utf8List, list(r => r.features.visualizations)],
            ['diagnostics', utf8List, list(r => r.diagnostics)],
        ],
        rows.length,
    );
}

/// The SELECT list that casts the staged doubles back to real, so that the Parquet files hold 32-bit floats.
/// Everything else is passed through.
export function exportSelect(table: arrow.Table): string {
    return table.schema.fields.map(f => {
        const name = `"${f.name.replace(/"/g, '""')}"`;
        if (f.type.typeId === arrow.Type.Float) return `${name}::real AS ${name}`;
        if (f.type.typeId === arrow.Type.List && (f.type as arrow.List).valueType.typeId === arrow.Type.Float) {
            return `${name}::real[] AS ${name}`;
        }
        return name;
    }).join(', ');
}
