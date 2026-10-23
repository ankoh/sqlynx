import type * as arrow from 'apache-arrow';

import type { EmbeddedComputeDatabase, EmbeddedExternalDirectoryDatabase } from '../database/embedded_database.js';

/// Hyper writes Parquet exports below this OPFS directory, they are read back and removed right after.
export const PARQUET_EXPORT_DIRECTORY = 'exports';
const PARQUET_EXPORT_FILE = 'result.parquet';

export type ParquetExportDatabase = EmbeddedComputeDatabase & EmbeddedExternalDirectoryDatabase;

export function supportsParquetExport(database: EmbeddedComputeDatabase | null): database is ParquetExportDatabase {
    return database != null && 'registerExternalDirectory' in database && 'removeExternalDirectory' in database;
}

/// Write an Arrow table as Parquet file to OPFS with Hyper and read the file back.
/// Hyper only copies into registered targets, so every export mounts its own OPFS directory read-write.
export async function exportArrowTableAsParquet(
    database: ParquetExportDatabase,
    table: arrow.Table,
    getOPFSRoot: () => Promise<FileSystemDirectoryHandle> = () => navigator.storage.getDirectory(),
): Promise<Uint8Array> {
    const root = await getOPFSRoot();
    const exports = await root.getDirectoryHandle(PARQUET_EXPORT_DIRECTORY, { create: true });
    const id = crypto.randomUUID();
    const directory = await exports.getDirectoryHandle(id, { create: true });
    try {
        const tableName = `__parquet_export_${id.replace(/-/g, '_')}`;
        const path = await database.registerExternalDirectory(directory, `/mnt/external/parquet-export-${id}`, 'readwrite');
        try {
            const connection = await database.connect({ pooled: true });
            try {
                await connection.insertArrowTable(table, { name: tableName });
                try {
                    await connection.execute(
                        `COPY (SELECT * FROM "${tableName}") TO '${path}/${PARQUET_EXPORT_FILE}' WITH (format => 'parquet')`,
                    );
                } finally {
                    await connection.execute(`DROP TABLE IF EXISTS "${tableName}"`);
                }
            } finally {
                await connection.close();
            }
        } finally {
            await database.removeExternalDirectory(path);
        }
        const file = await (await directory.getFileHandle(PARQUET_EXPORT_FILE)).getFile();
        return new Uint8Array(await file.arrayBuffer());
    } finally {
        await exports.removeEntry(id, { recursive: true });
    }
}
