import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as arrow from 'apache-arrow';
import { Compression, Table as WasmTable, WriterPropertiesBuilder, readParquet, writeParquet } from 'parquet-wasm';
import type { EmbedderConfig } from '../embedding/embedder.js';
import type { CommentRow, FeatureRow } from '../indexer.js';

export const FORMAT_VERSION = '1';

export type IndexKind = 'comments' | 'features';

const utf8 = new arrow.Utf8();
const int32 = new arrow.Int32();
const bool = new arrow.Bool();
const utf8List = new arrow.List(new arrow.Field('item', new arrow.Utf8(), true));

function embeddingType(dim: number): arrow.FixedSizeList<arrow.Float32> {
    return new arrow.FixedSizeList(dim, new arrow.Field('item', new arrow.Float32(), false));
}

function column<T extends arrow.DataType>(values: any[], type: T): arrow.Data<T> {
    const vector = arrow.vectorFromArray(values, type);
    return (vector.data.length > 0 ? vector.data[0] : arrow.makeData({ type, length: 0 })) as arrow.Data<T>;
}

function embeddingColumn(vectors: Float32Array[], dim: number): arrow.Data<arrow.FixedSizeList<arrow.Float32>> {
    const type = embeddingType(dim);
    const flat = new Float32Array(vectors.length * dim);
    vectors.forEach((v, i) => {
        if (v.length !== dim) throw new Error(`embedding ${i} has dimension ${v.length}, expected ${dim}`);
        flat.set(v, i * dim);
    });
    return arrow.makeData({
        type,
        length: vectors.length,
        nullCount: 0,
        child: arrow.makeData({ type: new arrow.Float32(), length: flat.length, data: flat }),
    });
}

function buildTable(columns: [string, arrow.DataType, arrow.Data][], length: number, metadata: Map<string, string>): arrow.Table {
    const fields = columns.map(([name, type]) => new arrow.Field(name, type, false));
    const schema = new arrow.Schema(fields, metadata);
    const struct = arrow.makeData({
        type: new arrow.Struct(fields),
        length,
        nullCount: 0,
        children: columns.map(([, , data]) => data),
    });
    return new arrow.Table([new arrow.RecordBatch(schema, struct)]);
}

export function indexMetadata(kind: IndexKind, config: EmbedderConfig, dim: number, coreVersion: string): Map<string, string> {
    return new Map<string, string>([
        ['dashql_embed.format_version', FORMAT_VERSION],
        ['dashql_embed.kind', kind],
        ['dashql_embed.model', config.model],
        ['dashql_embed.dtype', config.dtype],
        ['dashql_embed.pooling', config.pooling],
        ['dashql_embed.query_prefix', config.queryPrefix],
        ['dashql_embed.document_prefix', config.documentPrefix],
        ['dashql_embed.max_tokens', String(config.maxTokens)],
        ['dashql_embed.dim', String(dim)],
        ['dashql_embed.dashql_core_version', coreVersion],
    ]);
}

export function commentsTable(rows: CommentRow[], dim: number, metadata: Map<string, string>): arrow.Table {
    return buildTable(
        [
            ['entry_id', utf8, column(rows.map(r => r.entryId), utf8)],
            ['script_name', utf8, column(rows.map(r => r.scriptName), utf8)],
            ['script_hash', utf8, column(rows.map(r => r.scriptHash), utf8)],
            ['chunk_index', int32, column(rows.map(r => r.chunkIndex), int32)],
            ['source', utf8, column(rows.map(r => r.source), utf8)],
            ['text', utf8, column(rows.map(r => r.text), utf8)],
            ['token_count', int32, column(rows.map(r => r.tokenCount), int32)],
            ['embedding', embeddingType(dim), embeddingColumn(rows.map(r => r.embedding), dim)],
        ],
        rows.length,
        metadata,
    );
}

export function featuresTable(rows: FeatureRow[], dim: number, metadata: Map<string, string>): arrow.Table {
    const list = (pick: (r: FeatureRow) => string[]): arrow.Data => column(rows.map(pick), utf8List);
    return buildTable(
        [
            ['script_name', utf8, column(rows.map(r => r.scriptName), utf8)],
            ['script_hash', utf8, column(rows.map(r => r.scriptHash), utf8)],
            ['sql', utf8, column(rows.map(r => r.sql), utf8)],
            ['feature_text', utf8, column(rows.map(r => r.featureText), utf8)],
            ['token_count', int32, column(rows.map(r => r.tokenCount), int32)],
            ['truncated', bool, column(rows.map(r => r.truncated), bool)],
            ['embedding', embeddingType(dim), embeddingColumn(rows.map(r => r.embedding), dim)],
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
        metadata,
    );
}

export async function writeParquetFile(path: string, table: arrow.Table): Promise<void> {
    const properties = new WriterPropertiesBuilder().setCompression(Compression.ZSTD).build();
    const bytes = writeParquet(WasmTable.fromIPCStream(arrow.tableToIPC(table, 'stream')), properties);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
}

export interface IndexFile {
    table: arrow.Table;
    metadata: Map<string, string>;
    dim: number;
}

export async function readParquetFile(path: string): Promise<IndexFile> {
    const table = arrow.tableFromIPC(readParquet(new Uint8Array(await readFile(path))).intoIPCStream());
    const metadata = new Map<string, string>(table.schema.metadata);
    const dim = Number(metadata.get('dashql_embed.dim'));
    if (!Number.isInteger(dim) || dim <= 0) {
        throw new Error(`${path} is not a dashql-embed index: missing dashql_embed.dim metadata`);
    }
    return { table, metadata, dim };
}

/// Read the embedding column as flat Float32Array
export function embeddingsOf(file: IndexFile): Float32Array {
    const column = file.table.getChild('embedding')!;
    const out = new Float32Array(file.table.numRows * file.dim);
    let offset = 0;
    for (const data of column.data) {
        const values = data.children[0].values as Float32Array;
        const length = data.length * file.dim;
        out.set(values.subarray(data.offset * file.dim, data.offset * file.dim + length), offset);
        offset += length;
    }
    return out;
}
