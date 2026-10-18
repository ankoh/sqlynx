import type * as arrow from 'apache-arrow';

import type {
    EmbeddedExternalDirectoryDatabase,
} from '../platform/database/embedded_database.js';
import { AtlasSql, quoteIdentifier, quoteString } from './atlas_sql.js';
import { ATLAS_INDEX_FILE, ATLAS_STALE_FILES } from './index/files.js';
import type { LayoutResult } from './index/layout.js';
import type { IndexRow } from './index/rows.js';
import {
    exportSelect,
    indexTable,
    EMBEDDING_COLUMN,
    EMBEDDING_MODEL_COLUMN,
    LAYOUT_COLUMNS,
    LAYOUT_DIMS,
    type IndexEmbedder,
} from './index/tables.js';

/// Hyper only reads and writes files below /mnt/external/, one folder is mounted at a time
export const ATLAS_MOUNT_PATH = '/mnt/external/atlas';

export interface AtlasLocation {
    directory: FileSystemDirectoryHandle;
    /// The Parquet file of the index
    path: string;
}

export function externalDirectoryDatabase(database: unknown): EmbeddedExternalDirectoryDatabase | undefined {
    if (database == null || typeof database !== 'object') return undefined;
    if (!('registerExternalDirectory' in database) || !('removeExternalDirectory' in database)) return undefined;
    return database as EmbeddedExternalDirectoryDatabase;
}

/// Mount the selected folder read-write: the parquet files are written there and read back through Hyper
export async function mountFolder(
    database: EmbeddedExternalDirectoryDatabase,
    directory: FileSystemDirectoryHandle,
): Promise<AtlasLocation> {
    const path = await database.registerExternalDirectory(directory, ATLAS_MOUNT_PATH, 'readwrite');
    return { directory, path: `${path}/${ATLAS_INDEX_FILE}` };
}

export async function unmountFolder(database: EmbeddedExternalDirectoryDatabase): Promise<void> {
    await database.removeExternalDirectory(ATLAS_MOUNT_PATH);
}

export const externalTable = (path: string): string => `external(${quoteString(path)})`;

/// Does the folder hold an index file? A folder without one is indexed right away.
export async function hasIndexFile(directory: FileSystemDirectoryHandle): Promise<boolean> {
    try {
        await directory.getFileHandle(ATLAS_INDEX_FILE);
        return true;
    } catch (e) {
        if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e;
        return false;
    }
}

/// The scripts of the index file with the hashes of their texts at indexing time
export async function loadIndexedScripts(sql: AtlasSql, location: AtlasLocation): Promise<Map<string, string>> {
    const table = await sql.query(
        'Load indexed scripts',
        `SELECT DISTINCT script_name, script_hash FROM ${externalTable(location.path)}`,
    );
    const scripts = new Map<string, string>();
    for (const row of table.toArray()) {
        scripts.set(String(row.script_name), String(row.script_hash));
    }
    return scripts;
}

/// The number of scripts that were added, changed or removed since the index was written
export function countOutdatedScripts(indexed: ReadonlyMap<string, string>, current: ReadonlyMap<string, string>): number {
    let outdated = 0;
    for (const [name, hash] of current) {
        if (indexed.get(name) !== hash) ++outdated;
    }
    for (const name of indexed.keys()) {
        if (!current.has(name)) ++outdated;
    }
    return outdated;
}

/// The embedded description chunks at their 3D positions
export interface IndexPoints {
    /// The distinct script names
    scripts: string[];
    /// The index into `scripts` of every point
    owners: Int32Array;
    /// LAYOUT_DIMS values per point, the 98th percentile radius of the cloud is 1
    coords: Float32Array;
    /// The description chunk of every point
    details: string[];
    /// The tables that the script of every point reads
    tables: string[][];
}

function listItems(value: unknown): string[] {
    if (value == null) return [];
    const items = typeof (value as { toArray?: unknown }).toArray === 'function'
        ? (value as { toArray(): Iterable<unknown> }).toArray()
        : (value as Iterable<unknown>);
    return Array.from(items, v => String(v));
}

/// Columns that the index file must have. A file without them was written by another version, it is reported as
/// unreadable and the page asks to reindex the folder.
const REQUIRED_COLUMNS: readonly string[] = [
    'script_name',
    'description_chunk',
    EMBEDDING_MODEL_COLUMN,
    'structure_table_count',
    'structure_table_names',
    ...LAYOUT_COLUMNS,
];

/// Read the index file without its embeddings, a row per description chunk. The columns depend on the metadata keys, so
/// the file is read with * and the embedding is dropped here.
export async function loadIndexTable(sql: AtlasSql, location: AtlasLocation): Promise<arrow.Table> {
    const table = await sql.query('Load index', `SELECT * FROM ${externalTable(location.path)}`);
    const names = table.schema.fields.map(f => f.name);
    const missing = REQUIRED_COLUMNS.filter(name => !names.includes(name));
    if (missing.length > 0) {
        throw new Error(`${ATLAS_INDEX_FILE} has no column ${missing.map(quoteIdentifier).join(', ')}`);
    }
    return table.select(names.filter(name => name !== EMBEDDING_COLUMN));
}

/// Fail if the index file was embedded by another model than `model`, its embeddings are not comparable to the query.
/// Every row has the same model, so the first one is enough. An empty file has nothing to compare.
export async function checkIndexModel(sql: AtlasSql, location: AtlasLocation, model: string): Promise<void> {
    const table = await sql.query(
        'Load index model',
        `SELECT ${quoteIdentifier(EMBEDDING_MODEL_COLUMN)} AS model FROM ${externalTable(location.path)} LIMIT 1`,
    );
    if (table.numRows === 0) return;
    const indexed = String(table.toArray()[0].model);
    if (indexed !== model) {
        throw new Error(`${ATLAS_INDEX_FILE} was embedded with ${indexed}, the atlas embeds with ${model}`);
    }
}

/// The columns of the index table that are shown as rows: the hash and the layout only matter to the atlas itself
export function indexRowsTable(table: arrow.Table): arrow.Table {
    const hidden = new Set<string>(['script_hash', ...LAYOUT_COLUMNS]);
    return table.select(table.schema.fields.map(f => f.name).filter(name => !hidden.has(name)));
}

/// The 3D layout of the index table, point i is row i
export function indexPoints(table: arrow.Table): IndexPoints {
    const names = table.getChild('script_name');
    const text = table.getChild('description_chunk');
    const tableLists = table.getChild('structure_table_names');
    const axes = LAYOUT_COLUMNS.map(name => table.getChild(name));
    if (names == null || axes.some(axis => axis == null)) {
        return { scripts: [], owners: new Int32Array(0), coords: new Float32Array(0), details: [], tables: [] };
    }
    const scripts: string[] = [];
    const indexOf = new Map<string, number>();
    const owners = new Int32Array(table.numRows);
    const coords = new Float32Array(table.numRows * LAYOUT_DIMS);
    const details: string[] = [];
    const tables: string[][] = [];
    for (let i = 0; i < table.numRows; ++i) {
        const name = String(names.get(i));
        let owner = indexOf.get(name);
        if (owner === undefined) {
            owner = scripts.length;
            indexOf.set(name, owner);
            scripts.push(name);
        }
        owners[i] = owner;
        const value = text?.get(i);
        details.push(value == null ? '' : String(value));
        tables.push(listItems(tableLists?.get(i)));
        axes.forEach((axis, d) => { coords[i * LAYOUT_DIMS + d] = Number(axis!.get(i)); });
    }
    return { scripts, owners, coords, details, tables };
}

async function removeIfExists(directory: FileSystemDirectoryHandle, name: string): Promise<void> {
    try {
        await directory.removeEntry(name);
    } catch (e) {
        if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e;
    }
}

/// Write the rows as Parquet into the mounted folder: load an Arrow table into a scratch table and let Hyper COPY it.
/// Index files of earlier format versions are removed.
export async function writeIndexFile(
    sql: AtlasSql,
    location: AtlasLocation,
    rows: IndexRow[],
    layout: LayoutResult,
    embedder: IndexEmbedder,
): Promise<void> {
    const scratch = 'atlas_index_scratch';
    const table = indexTable(rows, embedder, layout.coords);
    await sql.run(`Drop ${scratch}`, `DROP TABLE IF EXISTS ${quoteIdentifier(scratch)}`);
    try {
        await sql.insert(`Load ${scratch}`, table, scratch);
        await removeIfExists(location.directory, ATLAS_INDEX_FILE);
        await sql.run(
            `Write ${ATLAS_INDEX_FILE}`,
            `COPY (SELECT ${exportSelect(table)} FROM ${quoteIdentifier(scratch)}) TO ${quoteString(location.path)} WITH (FORMAT PARQUET)`,
        );
    } finally {
        await sql.run(`Drop ${scratch}`, `DROP TABLE IF EXISTS ${quoteIdentifier(scratch)}`);
    }
    for (const name of ATLAS_STALE_FILES) {
        await removeIfExists(location.directory, name);
    }
}
