import type {
    EmbeddedExternalDirectoryDatabase,
} from '../platform/database/embedded_database.js';
import { AtlasSql, quoteIdentifier, quoteString } from './atlas_sql.js';
import { ATLAS_COMMENTS_FILE, ATLAS_FEATURES_FILE } from './index/files.js';
import type { CommentRow, FeatureRow } from './index/rows.js';
import { commentsTable, exportSelect, featuresTable, LAYOUT_COLUMNS, LAYOUT_DIMS } from './index/tables.js';

/// Hyper only reads and writes files below /mnt/external/, one folder is mounted at a time
export const ATLAS_MOUNT_PATH = '/mnt/external/atlas';

export interface AtlasLocation {
    directory: FileSystemDirectoryHandle;
    commentsPath: string;
    featuresPath: string;
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
    return {
        directory,
        commentsPath: `${path}/${ATLAS_COMMENTS_FILE}`,
        featuresPath: `${path}/${ATLAS_FEATURES_FILE}`,
    };
}

export async function unmountFolder(database: EmbeddedExternalDirectoryDatabase): Promise<void> {
    await database.removeExternalDirectory(ATLAS_MOUNT_PATH);
}

export const externalTable = (path: string): string => `external(${quoteString(path)})`;

/// Can Hyper read both index files? Used to decide whether an existing index is usable.
export async function indexFilesReadable(sql: AtlasSql, location: AtlasLocation): Promise<boolean> {
    try {
        await sql.query('Check atlas features', `SELECT count(*) AS n FROM ${externalTable(location.featuresPath)}`);
        await sql.query('Check atlas comments', `SELECT count(*) AS n FROM ${externalTable(location.commentsPath)}`);
        return true;
    } catch {
        return false;
    }
}

/// The two kinds of embeddings in the index, each has its own file and its own 3D layout
export type EmbeddingKind = 'features' | 'comments';

/// The embeddings of one index file at their 3D positions
export interface IndexPoints {
    /// The distinct script names
    scripts: string[];
    /// The index into `scripts` of every point
    owners: Int32Array;
    /// LAYOUT_DIMS values per point, the 98th percentile radius of the cloud is 1
    coords: Float32Array;
}

/// Read the 3D layout of one index file: a point per feature row or per comment chunk
export async function loadIndexPoints(sql: AtlasSql, location: AtlasLocation, kind: EmbeddingKind): Promise<IndexPoints> {
    const path = kind === 'features' ? location.featuresPath : location.commentsPath;
    const layoutColumns = LAYOUT_COLUMNS[kind];
    const columns = ['script_name', ...layoutColumns].map(quoteIdentifier).join(', ');
    const table = await sql.query(`Load ${kind} layout`, `SELECT ${columns} FROM ${externalTable(path)}`);
    const names = table.getChild('script_name');
    const axes = layoutColumns.map(name => table.getChild(name));
    if (names == null || axes.some(axis => axis == null)) {
        return { scripts: [], owners: new Int32Array(0), coords: new Float32Array(0) };
    }
    const scripts: string[] = [];
    const indexOf = new Map<string, number>();
    const owners = new Int32Array(table.numRows);
    const coords = new Float32Array(table.numRows * LAYOUT_DIMS);
    for (let i = 0; i < table.numRows; ++i) {
        const name = String(names.get(i));
        let owner = indexOf.get(name);
        if (owner === undefined) {
            owner = scripts.length;
            indexOf.set(name, owner);
            scripts.push(name);
        }
        owners[i] = owner;
        axes.forEach((axis, d) => { coords[i * LAYOUT_DIMS + d] = Number(axis!.get(i)); });
    }
    return { scripts, owners, coords };
}

async function removeIfExists(directory: FileSystemDirectoryHandle, name: string): Promise<void> {
    try {
        await directory.removeEntry(name);
    } catch (e) {
        if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e;
    }
}

/// Write the rows as Parquet into the mounted folder: load an Arrow table into a scratch table and let Hyper COPY it
export async function writeIndexFiles(
    sql: AtlasSql,
    location: AtlasLocation,
    comments: CommentRow[],
    features: FeatureRow[],
    featureCoords: Float32Array,
    commentCoords: Float32Array,
    dim: number,
): Promise<void> {
    const files: [scratch: string, table: ReturnType<typeof commentsTable>, path: string, name: string][] = [
        ['atlas_comments_scratch', commentsTable(comments, dim, commentCoords), location.commentsPath, ATLAS_COMMENTS_FILE],
        ['atlas_features_scratch', featuresTable(features, dim, featureCoords), location.featuresPath, ATLAS_FEATURES_FILE],
    ];
    for (const [scratch, table, path, name] of files) {
        await sql.run(`Drop ${scratch}`, `DROP TABLE IF EXISTS ${quoteIdentifier(scratch)}`);
        try {
            await sql.insert(`Load ${scratch}`, table, scratch);
            await removeIfExists(location.directory, name);
            await sql.run(
                `Write ${name}`,
                `COPY (SELECT ${exportSelect(table)} FROM ${quoteIdentifier(scratch)}) TO ${quoteString(path)} WITH (FORMAT PARQUET)`,
            );
        } finally {
            await sql.run(`Drop ${scratch}`, `DROP TABLE IF EXISTS ${quoteIdentifier(scratch)}`);
        }
    }
}
