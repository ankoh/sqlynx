import type {
    EmbeddedExternalDirectoryDatabase,
} from '../platform/database/embedded_database.js';
import { AtlasSql, quoteIdentifier, quoteString } from './atlas_sql.js';
import {
    ATLAS_DESCRIPTION_FILE,
    ATLAS_INDEX_FILES,
    ATLAS_PROPERTIES_FILE,
    ATLAS_STALE_FILES,
    ATLAS_SYNTAX_FILE,
} from './index/files.js';
import { EMBEDDING_KINDS, type EmbeddingKind, type IndexResult } from './index/indexer.js';
import type { LayoutResult } from './index/layout.js';
import {
    descriptionTable,
    exportSelect,
    propertiesTable,
    syntaxTable,
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
    syntax: ATLAS_SYNTAX_FILE,
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
            syntax: `${path}/${ATLAS_SYNTAX_FILE}`,
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
    /// What a point says about its script: the description chunk, the tables of the syntax or the properties
    details: string[];
}

function listItems(value: unknown): string[] {
    if (value == null) return [];
    const items = typeof (value as { toArray?: unknown }).toArray === 'function'
        ? (value as { toArray(): Iterable<unknown> }).toArray()
        : (value as Iterable<unknown>);
    return Array.from(items, v => String(v));
}

/// Read the 3D layout of one index file: a point per syntax row, description chunk or properties row
export async function loadIndexPoints(sql: AtlasSql, location: AtlasLocation, kind: EmbeddingKind): Promise<IndexPoints> {
    const detailColumn = kind === 'syntax' ? 'tables' : 'text';
    const columns = ['script_name', detailColumn, ...LAYOUT_COLUMNS].map(quoteIdentifier).join(', ');
    const table = await sql.query(`Load ${kind} layout`, `SELECT ${columns} FROM ${externalTable(location.paths[kind])}`);
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
        details.push(kind === 'syntax' ? listItems(value).join(', ') : value == null ? '' : String(value));
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
    const tables: Record<EmbeddingKind, ReturnType<typeof syntaxTable>> = {
        syntax: syntaxTable(rows.syntax, dim, layouts.syntax.coords),
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
