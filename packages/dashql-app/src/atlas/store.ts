import type * as arrow from 'apache-arrow';

import type {
    EmbeddedExternalDirectoryDatabase,
} from '../platform/database/embedded_database.js';
import { AtlasSql, quoteIdentifier, quoteString } from './atlas_sql.js';
import {
    ATLAS_DESCRIPTION_FILE,
    ATLAS_INDEX_FILES,
    ATLAS_PROPERTIES_FILE,
    ATLAS_STALE_FILES,
    ATLAS_STRUCTURE_FILE,
} from './index/files.js';
import { EMBEDDING_KINDS, type EmbeddingKind, type IndexResult } from './index/indexer.js';
import type { LayoutResult } from './index/layout.js';
import {
    descriptionTable,
    exportSelect,
    propertiesTable,
    structureTable,
    EMBEDDING_COLUMN,
    LAYOUT_COLUMNS,
    LAYOUT_DIMS,
} from './index/tables.js';

export type { EmbeddingKind } from './index/indexer.js';

/// Hyper only reads and writes files below /mnt/external/, one folder is mounted at a time
export const ATLAS_MOUNT_PATH = '/mnt/external/atlas';

export interface AtlasLocation {
    directory: FileSystemDirectoryHandle;
    /// The Parquet file of every embedding space
    paths: Record<EmbeddingKind, string>;
}

const FILE_NAMES: Record<EmbeddingKind, string> = {
    structure: ATLAS_STRUCTURE_FILE,
    description: ATLAS_DESCRIPTION_FILE,
    properties: ATLAS_PROPERTIES_FILE,
};

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
    return {
        directory,
        paths: {
            structure: `${path}/${ATLAS_STRUCTURE_FILE}`,
            description: `${path}/${ATLAS_DESCRIPTION_FILE}`,
            properties: `${path}/${ATLAS_PROPERTIES_FILE}`,
        },
    };
}

export async function unmountFolder(database: EmbeddedExternalDirectoryDatabase): Promise<void> {
    await database.removeExternalDirectory(ATLAS_MOUNT_PATH);
}

export const externalTable = (path: string): string => `external(${quoteString(path)})`;

/// Does the folder hold any index file? A folder without one is indexed right away.
export async function hasIndexFiles(directory: FileSystemDirectoryHandle): Promise<boolean> {
    for (const name of ATLAS_INDEX_FILES) {
        try {
            await directory.getFileHandle(name);
            return true;
        } catch (e) {
            if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e;
        }
    }
    return false;
}

/// The scripts of the index files with the hashes of their texts at indexing time
export async function loadIndexedScripts(sql: AtlasSql, location: AtlasLocation): Promise<Map<string, string>> {
    const selects = EMBEDDING_KINDS.map(kind => `SELECT script_name, script_hash FROM ${externalTable(location.paths[kind])}`);
    const table = await sql.query(
        'Load indexed scripts',
        `SELECT DISTINCT script_name, script_hash FROM (${selects.join(' UNION ALL ')}) scripts`,
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

/// The embeddings of one index file at their 3D positions
export interface IndexPoints {
    /// The distinct script names
    scripts: string[];
    /// The index into `scripts` of every point
    owners: Int32Array;
    /// LAYOUT_DIMS values per point, the 98th percentile radius of the cloud is 1
    coords: Float32Array;
    /// What a point says about its script: the description chunk, the tables of the structure or the properties
    details: string[];
}

function listItems(value: unknown): string[] {
    if (value == null) return [];
    const items = typeof (value as { toArray?: unknown }).toArray === 'function'
        ? (value as { toArray(): Iterable<unknown> }).toArray()
        : (value as Iterable<unknown>);
    return Array.from(items, v => String(v));
}

/// Columns that every file of a kind must have. The count columns of the structure were added after the first version,
/// files without them are reported as unreadable and the page asks to reindex the folder.
const REQUIRED_COLUMNS: Record<EmbeddingKind, readonly string[]> = {
    description: ['script_name', 'text', ...LAYOUT_COLUMNS],
    structure: ['script_name', 'tables', 'table_count', ...LAYOUT_COLUMNS],
    properties: ['script_name', 'text', ...LAYOUT_COLUMNS],
};

/// Read one index file without its embeddings, a row per structure, description chunk or properties block. The columns
/// of the properties file depend on the property keys, so the file is read with * and the embedding is dropped here.
export async function loadIndexTable(sql: AtlasSql, location: AtlasLocation, kind: EmbeddingKind): Promise<arrow.Table> {
    const table = await sql.query(`Load ${kind} index`, `SELECT * FROM ${externalTable(location.paths[kind])}`);
    const names = table.schema.fields.map(f => f.name);
    const missing = REQUIRED_COLUMNS[kind].filter(name => !names.includes(name));
    if (missing.length > 0) {
        throw new Error(`${FILE_NAMES[kind]} has no column ${missing.map(quoteIdentifier).join(', ')}`);
    }
    return table.select(names.filter(name => name !== EMBEDDING_COLUMN));
}

/// The columns of an index table that are shown as rows: the hash and the layout only matter to the atlas itself
export function indexRowsTable(table: arrow.Table): arrow.Table {
    const hidden = new Set<string>(['script_hash', ...LAYOUT_COLUMNS]);
    return table.select(table.schema.fields.map(f => f.name).filter(name => !hidden.has(name)));
}

/// The 3D layout of one index table, point i is row i
export function indexPoints(table: arrow.Table, kind: EmbeddingKind): IndexPoints {
    const detailColumn = kind === 'structure' ? 'tables' : 'text';
    const names = table.getChild('script_name');
    const detail = table.getChild(detailColumn);
    const axes = LAYOUT_COLUMNS.map(name => table.getChild(name));
    if (names == null || axes.some(axis => axis == null)) {
        return { scripts: [], owners: new Int32Array(0), coords: new Float32Array(0), details: [] };
    }
    const scripts: string[] = [];
    const indexOf = new Map<string, number>();
    const owners = new Int32Array(table.numRows);
    const coords = new Float32Array(table.numRows * LAYOUT_DIMS);
    const details: string[] = [];
    for (let i = 0; i < table.numRows; ++i) {
        const name = String(names.get(i));
        let owner = indexOf.get(name);
        if (owner === undefined) {
            owner = scripts.length;
            indexOf.set(name, owner);
            scripts.push(name);
        }
        owners[i] = owner;
        const value = detail?.get(i);
        details.push(kind === 'structure' ? listItems(value).join(', ') : value == null ? '' : String(value));
        axes.forEach((axis, d) => { coords[i * LAYOUT_DIMS + d] = Number(axis!.get(i)); });
    }
    return { scripts, owners, coords, details };
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
export async function writeIndexFiles(
    sql: AtlasSql,
    location: AtlasLocation,
    rows: IndexResult,
    layouts: Record<EmbeddingKind, LayoutResult>,
    dim: number,
): Promise<void> {
    const tables: Record<EmbeddingKind, ReturnType<typeof structureTable>> = {
        structure: structureTable(rows.structure, dim, layouts.structure.coords),
        description: descriptionTable(rows.description, dim, layouts.description.coords),
        properties: propertiesTable(rows.properties, dim, layouts.properties.coords),
    };
    for (const kind of EMBEDDING_KINDS) {
        const scratch = `atlas_${kind}_scratch`;
        const table = tables[kind];
        const name = FILE_NAMES[kind];
        await sql.run(`Drop ${scratch}`, `DROP TABLE IF EXISTS ${quoteIdentifier(scratch)}`);
        try {
            await sql.insert(`Load ${scratch}`, table, scratch);
            await removeIfExists(location.directory, name);
            await sql.run(
                `Write ${name}`,
                `COPY (SELECT ${exportSelect(table)} FROM ${quoteIdentifier(scratch)}) TO ${quoteString(location.paths[kind])} WITH (FORMAT PARQUET)`,
            );
        } finally {
            await sql.run(`Drop ${scratch}`, `DROP TABLE IF EXISTS ${quoteIdentifier(scratch)}`);
        }
    }
    for (const name of ATLAS_STALE_FILES) {
        await removeIfExists(location.directory, name);
    }
}
