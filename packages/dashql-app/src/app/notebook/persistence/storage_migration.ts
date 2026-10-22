import type { Logger } from '../../../platform/logger/logger.js';
import type { StorageBackend } from './storage_backend.js';
import { rebaseNotebookAttachmentPaths } from './notebook_bundle.js';

const LOG_CTX = 'storage_migration';

/// The result of copying one or more notebooks between backends.
export interface MigrationResult {
    /// The number of notebooks copied
    notebookCount: number;
    /// The number of files written (manifests + schema + functions + scripts + data)
    fileCount: number;
}

/// Copy a single notebook's files from `source` to `target`, keyed by the same UUID.
///
/// The UUID is the authoritative identity and is preserved verbatim - nothing is re-prefixed. The
/// notebook manifest, schema, functions, flat scripts, and binary data are copied as
/// they are. `source` is left untouched; the caller deletes the source copy only after the copy is
/// verified.
export async function copyNotebook(
    notebookId: string,
    source: StorageBackend,
    target: StorageBackend,
    logger: Logger,
): Promise<MigrationResult> {
    let fileCount = 0;

    // Notebook manifest (copied verbatim; notebookId is preserved)
    const notebookData = await source.loadNotebook(notebookId);
    await target.saveNotebookManifest(notebookId, notebookData);
    fileCount++;

    // Schema
    const schema = await source.loadNotebookSchema(notebookId);
    if (schema != null) {
        await target.saveNotebookSchema(notebookId, schema);
        fileCount++;
    }

    // Catalog changes of executed statements
    const catalogChangesSql = await source.loadNotebookCatalogChanges(notebookId);
    if (catalogChangesSql != null) {
        await target.saveNotebookCatalogChanges(notebookId, catalogChangesSql);
        fileCount++;
    }

    // Functions
    const functions = await source.loadNotebookFunctions(notebookId);
    if (functions != null) {
        await target.saveNotebookFunctions(notebookId, functions);
        fileCount++;
    }

    for (const script of await source.loadScripts(notebookId)) {
        await target.saveScript(notebookId, script.name, script.sql);
        fileCount++;
    }
    for (const file of await source.listDataFiles(notebookId)) {
        await target.saveDataFile(notebookId, file.name, await source.loadDataFile(notebookId, file.name));
        fileCount++;
    }

    logger.info('copied notebook', { notebookId, files: String(fileCount) }, LOG_CTX);
    return { notebookCount: 1, fileCount };
}

/// Clone a notebook into `target` under a new UUID (always used for OPFS duplicates).
///
/// Rewrites `notebookId`, drops the display-only `notebookPath`, and suffixes a named notebook
/// with " (copy)". The clone references the same connections. Query result cache is not copied. On any write failure the new notebook is
/// deleted so a half-written clone cannot linger in the registry.
export async function cloneNotebook(
    sourceNotebookId: string,
    source: StorageBackend,
    target: StorageBackend,
    newNotebookId: string,
    logger: Logger,
): Promise<MigrationResult> {
    let fileCount = 0;
    try {
        // The copy shares the connections of its source
        const notebookData = {
            ...(await source.loadNotebook(sourceNotebookId)),
            notebookId: newNotebookId,
        };
        delete notebookData.notebookPath;
        const trimmedName = notebookData.name?.trim();
        if (trimmedName) {
            notebookData.name = `${trimmedName} (copy)`;
        }

        await target.saveNotebookManifest(newNotebookId, notebookData);
        fileCount++;

        const schema = rebaseNotebookAttachmentPaths(await source.loadNotebookSchema(sourceNotebookId), sourceNotebookId, newNotebookId);
        if (schema != null) {
            await target.saveNotebookSchema(newNotebookId, schema);
            fileCount++;
        }

        const catalogChangesSql = await source.loadNotebookCatalogChanges(sourceNotebookId);
        if (catalogChangesSql != null) {
            await target.saveNotebookCatalogChanges(newNotebookId, catalogChangesSql);
            fileCount++;
        }

        const functions = rebaseNotebookAttachmentPaths(await source.loadNotebookFunctions(sourceNotebookId), sourceNotebookId, newNotebookId);
        if (functions != null) {
            await target.saveNotebookFunctions(newNotebookId, functions);
            fileCount++;
        }

        for (const script of await source.loadScripts(sourceNotebookId)) {
            await target.saveScript(newNotebookId, script.name,
                rebaseNotebookAttachmentPaths(script.sql, sourceNotebookId, newNotebookId)!);
            fileCount++;
        }
        for (const file of await source.listDataFiles(sourceNotebookId)) {
            await target.saveDataFile(newNotebookId, file.name, await source.loadDataFile(sourceNotebookId, file.name));
            fileCount++;
        }

        logger.info('cloned notebook', {
            sourceNotebookId,
            notebookId: newNotebookId,
            files: String(fileCount),
        }, LOG_CTX);
        return { notebookCount: 1, fileCount };
    } catch (error) {
        try {
            await target.deleteNotebook(newNotebookId);
        } catch {
            // Preserve the clone error if rollback fails.
        }
        throw error;
    }
}

/// Verify a single notebook was copied completely by re-reading `target`.
///
/// Checks that the target notebook parses with a notebookId and that its per-notebook script count
/// matches the source. Returns false on any mismatch so the caller can abort and keep the source
/// untouched.
export async function verifyNotebook(notebookId: string, source: StorageBackend, target: StorageBackend): Promise<boolean> {
    let targetData;
    try {
        targetData = await target.loadNotebook(notebookId);
    } catch {
        return false;
    }
    if (!targetData.notebookId) {
        return false;
    }

    if ((await source.loadScripts(notebookId)).length !== (await target.loadScripts(notebookId)).length) return false;
    try {
        const sourceFiles = await source.listDataFiles(notebookId);
        const targetFiles = await target.listDataFiles(notebookId);
        if (sourceFiles.length !== targetFiles.length) return false;
        for (const file of sourceFiles) {
            const sourceBytes = await source.loadDataFile(notebookId, file.name);
            const targetBytes = await target.loadDataFile(notebookId, file.name);
            if (sourceBytes.length !== targetBytes.length || !sourceBytes.every((byte, i) => byte === targetBytes[i])) return false;
        }
        return true;
    } catch {
        return false;
    }
}
