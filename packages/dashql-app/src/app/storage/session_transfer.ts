import type { Logger } from '../../platform/logger/logger.js';
import type { StorageBackend } from './storage_backend.js';
import { rebaseSessionAttachmentPaths } from './session_bundle.js';

const LOG_CTX = 'session_transfer';

/// The result of copying one or more sessions between backends.
export interface SessionTransferResult {
    /// The number of sessions copied
    sessionCount: number;
    /// The number of files written (manifests + schema + functions + scripts + data)
    fileCount: number;
}

/// Copy a single session's files from `source` to `target`, keyed by the same UUID.
///
/// The UUID is the authoritative identity and is preserved verbatim - nothing is re-prefixed. The
/// session manifest, schema, functions, flat scripts, and binary data are copied as
/// they are. `source` is left untouched; the caller deletes the source copy only after the copy is
/// verified.
export async function copySession(
    sessionId: string,
    source: StorageBackend,
    target: StorageBackend,
    logger: Logger,
): Promise<SessionTransferResult> {
    let fileCount = 0;

    // Session manifest (copied verbatim; sessionId is preserved)
    const sessionData = await source.loadSession(sessionId);
    await target.saveSessionManifest(sessionId, sessionData);
    fileCount++;

    // Schema
    const schema = await source.loadSessionSchema(sessionId);
    if (schema != null) {
        await target.saveSessionSchema(sessionId, schema);
        fileCount++;
    }

    // Catalog changes of executed statements
    const catalogChangesSql = await source.loadSessionCatalogChanges(sessionId);
    if (catalogChangesSql != null) {
        await target.saveSessionCatalogChanges(sessionId, catalogChangesSql);
        fileCount++;
    }

    // Functions
    const functions = await source.loadSessionFunctions(sessionId);
    if (functions != null) {
        await target.saveSessionFunctions(sessionId, functions);
        fileCount++;
    }

    for (const script of await source.loadScripts(sessionId)) {
        await target.saveScript(sessionId, script.name, script.sql);
        fileCount++;
    }
    for (const file of await source.listDataFiles(sessionId)) {
        await target.saveDataFile(sessionId, file.name, await source.loadDataFile(sessionId, file.name));
        fileCount++;
    }

    logger.info('copied session', { sessionId, files: String(fileCount) }, LOG_CTX);
    return { sessionCount: 1, fileCount };
}

/// Clone a session into `target` under a new UUID (always used for OPFS duplicates).
///
/// Rewrites `sessionId`, drops the display-only `sessionPath`, and suffixes a named session
/// with " (copy)". The clone references the same connections. Query result cache is not copied. On any write failure the new session is
/// deleted so a half-written clone cannot linger in the registry.
export async function cloneSession(
    sourceSessionId: string,
    source: StorageBackend,
    target: StorageBackend,
    newSessionId: string,
    logger: Logger,
): Promise<SessionTransferResult> {
    let fileCount = 0;
    try {
        // The copy shares the connections of its source
        const sessionData = {
            ...(await source.loadSession(sourceSessionId)),
            sessionId: newSessionId,
        };
        delete sessionData.sessionPath;
        const trimmedName = sessionData.name?.trim();
        if (trimmedName) {
            sessionData.name = `${trimmedName} (copy)`;
        }

        await target.saveSessionManifest(newSessionId, sessionData);
        fileCount++;

        const schema = rebaseSessionAttachmentPaths(await source.loadSessionSchema(sourceSessionId), sourceSessionId, newSessionId);
        if (schema != null) {
            await target.saveSessionSchema(newSessionId, schema);
            fileCount++;
        }

        const catalogChangesSql = await source.loadSessionCatalogChanges(sourceSessionId);
        if (catalogChangesSql != null) {
            await target.saveSessionCatalogChanges(newSessionId, catalogChangesSql);
            fileCount++;
        }

        const functions = rebaseSessionAttachmentPaths(await source.loadSessionFunctions(sourceSessionId), sourceSessionId, newSessionId);
        if (functions != null) {
            await target.saveSessionFunctions(newSessionId, functions);
            fileCount++;
        }

        for (const script of await source.loadScripts(sourceSessionId)) {
            await target.saveScript(newSessionId, script.name,
                rebaseSessionAttachmentPaths(script.sql, sourceSessionId, newSessionId)!);
            fileCount++;
        }
        for (const file of await source.listDataFiles(sourceSessionId)) {
            await target.saveDataFile(newSessionId, file.name, await source.loadDataFile(sourceSessionId, file.name));
            fileCount++;
        }

        logger.info('cloned session', {
            sourceSessionId,
            sessionId: newSessionId,
            files: String(fileCount),
        }, LOG_CTX);
        return { sessionCount: 1, fileCount };
    } catch (error) {
        try {
            await target.deleteSession(newSessionId);
        } catch {
            // Preserve the clone error if rollback fails.
        }
        throw error;
    }
}

/// Verify a single session was copied completely by re-reading `target`.
///
/// Checks that the target session parses with a sessionId and that its per-session script count
/// matches the source. Returns false on any mismatch so the caller can abort and keep the source
/// untouched.
export async function verifySession(sessionId: string, source: StorageBackend, target: StorageBackend): Promise<boolean> {
    let targetData;
    try {
        targetData = await target.loadSession(sessionId);
    } catch {
        return false;
    }
    if (!targetData.sessionId) {
        return false;
    }

    if ((await source.loadScripts(sessionId)).length !== (await target.loadScripts(sessionId)).length) return false;
    try {
        const sourceFiles = await source.listDataFiles(sessionId);
        const targetFiles = await target.listDataFiles(sessionId);
        if (sourceFiles.length !== targetFiles.length) return false;
        for (const file of sourceFiles) {
            const sourceBytes = await source.loadDataFile(sessionId, file.name);
            const targetBytes = await target.loadDataFile(sessionId, file.name);
            if (sourceBytes.length !== targetBytes.length || !sourceBytes.every((byte, i) => byte === targetBytes[i])) return false;
        }
        return true;
    } catch {
        return false;
    }
}
