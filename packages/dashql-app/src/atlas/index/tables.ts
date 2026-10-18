import * as arrow from 'apache-arrow';

import type { IndexRow } from './rows.js';

/// Number of coordinates per row in the layout
export const LAYOUT_DIMS = 3;
/// The columns are prefixed by where they come from: `script_` (the file), `description_` (the description chunk, its
/// embedding and its position in the cloud), `metadata_` (the `@dashql:metadata` block) and `structure_` (the
/// analysis of the SQL).
export const EMBEDDING_COLUMN = 'description_embedding';
export const LAYOUT_COLUMNS = ['description_x', 'description_y', 'description_z'] as const;

const utf8 = new arrow.Utf8();
const int32 = new arrow.Int32();
const bool = new arrow.Bool();
/// The tables are only a staging area for Hyper: persistent tables of the compute database do not support 32-bit floats,
/// so floats travel as doubles and are cast back to real when the Parquet file is written (see `exportSelect`).
const float64 = new arrow.Float64();
const utf8List = new arrow.List(new arrow.Field('item', new arrow.Utf8(), true));
const embeddingType = new arrow.List(new arrow.Field('item', new arrow.Float64(), false));

/// Columns are not nullable unless they say so, only the metadata and count columns are
type Column = [name: string, type: arrow.DataType, data: arrow.Data, nullable?: boolean];

/// Columns are assembled from buffers. arrow.vectorFromArray goes through the Arrow builders, which compile their null
/// checks with `new Function`, and the CSP of the page does not allow that.
const encoder = new TextEncoder();

/// The validity bitmap of `values`, none if every value is present
function validity(values: unknown[]): { nullCount: number; nullBitmap?: Uint8Array } {
    const nullCount = values.reduce<number>((n, v) => n + (v == null ? 1 : 0), 0);
    if (nullCount === 0) return { nullCount };
    const nullBitmap = new Uint8Array(Math.ceil(values.length / 8));
    values.forEach((v, i) => {
        if (v != null) nullBitmap[i >> 3] |= 1 << (i & 7);
    });
    return { nullCount, nullBitmap };
}

function utf8Data(values: (string | null)[]): arrow.Data<arrow.Utf8> {
    const encoded = values.map(v => encoder.encode(v ?? ''));
    const offsets = new Int32Array(values.length + 1);
    let total = 0;
    encoded.forEach((bytes, i) => {
        offsets[i] = total;
        total += bytes.length;
    });
    offsets[values.length] = total;
    const data = new Uint8Array(total);
    encoded.forEach((bytes, i) => data.set(bytes, offsets[i]));
    return arrow.makeData({ type: utf8, length: values.length, ...validity(values), valueOffsets: offsets, data });
}

function boolData(values: (boolean | null)[]): arrow.Data<arrow.Bool> {
    const data = new Uint8Array(Math.ceil(values.length / 8));
    values.forEach((v, i) => {
        if (v) data[i >> 3] |= 1 << (i & 7);
    });
    return arrow.makeData({ type: bool, length: values.length, ...validity(values), data });
}

function int32Data(values: (number | null)[]): arrow.Data<arrow.Int32> {
    const data = Int32Array.from(values, v => v ?? 0);
    return arrow.makeData({ type: int32, length: values.length, ...validity(values), data });
}

function float64Data(values: (number | null)[]): arrow.Data<arrow.Float64> {
    const data = Float64Array.from(values, v => v ?? 0);
    return arrow.makeData({ type: float64, length: values.length, ...validity(values), data });
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
            return int32Data(values as (number | null)[]);
        case arrow.Type.Float:
            return float64Data(values as number[]);
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
    const fields = columns.map(([name, type, , nullable]) => new arrow.Field(name, type, nullable ?? false));
    const struct = arrow.makeData({
        type: new arrow.Struct(fields),
        length,
        nullCount: 0,
        children: columns.map(([, , data]) => data),
    });
    return new arrow.Table([new arrow.RecordBatch(new arrow.Schema(fields), struct)]);
}

/// The embedding and layout columns of the description chunks of `rows` rows, `coords` holds LAYOUT_DIMS values per row
function vectorColumns(vectors: Float32Array[], dim: number, coords: Float32Array): Column[] {
    const rows = vectors.length;
    if (coords.length !== rows * LAYOUT_DIMS) {
        throw new Error(`expected ${rows * LAYOUT_DIMS} layout values, got ${coords.length}`);
    }
    return [
        [EMBEDDING_COLUMN, embeddingType, embeddingColumn(vectors, dim)],
        ...LAYOUT_COLUMNS.map((name, d): Column => [
            name,
            float64,
            column(Array.from({ length: rows }, (_, i) => coords[i * LAYOUT_DIMS + d]), float64),
        ]),
    ];
}

/// The feature lists of the analysis and its diagnostics, each next to its count. The lists themselves cannot be
/// binned. The joins and the operators are not counted: how many joins a query has is up to the optimizer (a cross join
/// with a predicate is a join, too), and the operators are SQL clauses, not the operators of a plan.
/// The lists of the analysis are null for scripts that could not be analyzed.
const LISTS: [count: string | null, list: string, pick: (r: IndexRow) => string[] | null][] = [
    ['structure_statement_count', 'structure_statement_types', r => r.features?.statementTypes ?? null],
    ['structure_table_count', 'structure_table_names', r => r.features?.tables ?? null],
    ['structure_column_count', 'structure_column_names', r => r.features?.columns ?? null],
    ['structure_function_count', 'structure_function_names', r => r.features?.functions ?? null],
    ['structure_aggregate_count', 'structure_aggregate_names', r => r.features?.aggregates ?? null],
    ['structure_function_call_count', 'structure_function_call_expressions', r => r.features?.functionCalls ?? null],
    ['structure_cte_count', 'structure_cte_names', r => r.features?.ctes ?? null],
    [null, 'structure_join_conditions', r => r.features?.joins ?? null],
    ['structure_filter_count', 'structure_filter_predicates', r => r.features?.filters ?? null],
    [null, 'structure_operator_names', r => r.features?.operators ?? null],
    ['structure_visualization_count', 'structure_visualization_summaries', r => r.features?.visualizations ?? null],
    ['structure_diagnostic_count', 'structure_diagnostic_messages', r => r.diagnostics],
];

/// One column `metadata_<key>` per metadata key, in the order the keys are first seen. Numbers become doubles and
/// booleans bools if every row agrees, anything else is a string with objects and arrays as JSON. Rows without the key
/// are null.
function metadataColumns(rows: IndexRow[]): Column[] {
    const keys = [...new Set(rows.flatMap(r => Object.keys(r.metadata ?? {})))];
    return keys.map((key): Column => {
        const name = `metadata_${key}`;
        const values = rows.map(r => {
            const has = r.metadata != null && Object.prototype.hasOwnProperty.call(r.metadata, key);
            return (has ? r.metadata![key] : null) ?? null;
        });
        const present = values.filter(v => v != null);
        if (present.length > 0 && present.every(v => typeof v === 'number')) {
            return [name, float64, float64Data(values as (number | null)[]), true];
        }
        if (present.length > 0 && present.every(v => typeof v === 'boolean')) {
            return [name, bool, boolData(values as (boolean | null)[]), true];
        }
        const text = values.map(v => v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));
        return [name, utf8, utf8Data(text), true];
    });
}

/// A row per description chunk with the metadata and the analysis of its script, in this order: `script_`,
/// `description_`, `metadata_`, `structure_`. The script is not stored, it can be read from the SQL files. The counts
/// are null and the lists empty for scripts that could not be analyzed.
/// `coords` holds LAYOUT_DIMS values per row.
export function indexTable(rows: IndexRow[], dim: number, coords: Float32Array): arrow.Table {
    return buildTable(
        [
            ['script_name', utf8, column(rows.map(r => r.scriptName), utf8)],
            ['script_hash', utf8, column(rows.map(r => r.scriptHash), utf8)],
            ['description_chunk_index', int32, column(rows.map(r => r.chunkIndex), int32)],
            ['description_chunk', utf8, column(rows.map(r => r.text), utf8)],
            ...vectorColumns(rows.map(r => r.embedding), dim, coords),
            ...metadataColumns(rows),
            ...LISTS.flatMap(([count, list, pick]): Column[] => {
                const listColumn: Column = [list, utf8List, column(rows.map(r => pick(r) ?? []), utf8List)];
                if (count == null) return [listColumn];
                return [[count, int32, column(rows.map(r => pick(r)?.length ?? null), int32), true], listColumn];
            }),
        ],
        rows.length,
    );
}

/// The SELECT list that casts the staged doubles of the vector columns back to real, so that the Parquet file holds
/// 32-bit floats. Everything else is passed through, numeric metadata stays doubles.
export function exportSelect(table: arrow.Table): string {
    const vectors = new Set<string>([EMBEDDING_COLUMN, ...LAYOUT_COLUMNS]);
    return table.schema.fields.map(f => {
        const name = `"${f.name.replace(/"/g, '""')}"`;
        if (!vectors.has(f.name)) return name;
        if (f.type.typeId === arrow.Type.Float) return `${name}::real AS ${name}`;
        if (f.type.typeId === arrow.Type.List && (f.type as arrow.List).valueType.typeId === arrow.Type.Float) {
            return `${name}::real[] AS ${name}`;
        }
        return name;
    }).join(', ');
}
