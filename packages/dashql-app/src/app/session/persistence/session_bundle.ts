import type { DashQL, FlatBufferPtr, buffers } from '@ankoh/dashql-core';
import type { DataFileData, SessionData, ScriptData, StorageBackend } from './storage_backend.js';
import { STORAGE_CATALOG_FUNCTIONS, STORAGE_CATALOG_RELATIONS, StorageBackendType, validateDataFileName } from './storage_backend.js';
import {
    describeSessionValidationError,
    isValidUuid,
    validateSessionData,
} from './session_validation.js';

/// The durable, portable subset of a session. Derived cache files and storage-location metadata
/// are intentionally not represented here.
export interface SessionBundle {
    session: SessionData;
    schemaSql: string | null;
    functionsSql: string | null;
    scripts: ScriptData[];
    data?: DataFileData[];
}

export interface SessionCatalogValidationResult {
    bundle: SessionBundle;
    invalidFiles: Array<typeof STORAGE_CATALOG_RELATIONS | typeof STORAGE_CATALOG_FUNCTIONS>;
}

export function regenerateSessionDatabaseIds(session: SessionData): SessionData {
    const remap = (database: SessionData['mainDatabase']) => ({
        ...database,
        databaseId: crypto.randomUUID(),
    });
    return {
        ...session,
        mainDatabase: remap(session.mainDatabase),
        attachedDatabases: session.attachedDatabases.map(remap) as SessionData['attachedDatabases'],
    };
}

/// Rewrite only this session's canonical attachment paths after explicitly creating a new identity.
/// References to another session are left unchanged.
export function rebaseSessionAttachmentPaths(text: string | null, sourceSessionId: string, targetSessionId: string): string | null {
    if (text == null || sourceSessionId === targetSessionId) return text;
    return text.split(
        `/mnt/fs/sessions/${sourceSessionId}/attachments/`,
    ).join(`/mnt/fs/sessions/${targetSessionId}/attachments/`);
}

/// Parse catalog files on scratch scripts and omit malformed SQL before it can reach storage.
/// Analysis is intentionally excluded: imported catalogs may reference types or objects that are
/// only available once their connection has been restored.
export function filterInvalidSessionCatalogs(
    core: DashQL,
    bundle: SessionBundle,
): SessionCatalogValidationResult {
    const invalidFiles: SessionCatalogValidationResult['invalidFiles'] = [];
    const validate = (sql: string | null, fileName: SessionCatalogValidationResult['invalidFiles'][number]) => {
        if (sql == null || parsesWithoutErrors(core, sql)) return sql;
        invalidFiles.push(fileName);
        return null;
    };
    const schemaSql = validate(bundle.schemaSql, STORAGE_CATALOG_RELATIONS);
    const functionsSql = validate(bundle.functionsSql, STORAGE_CATALOG_FUNCTIONS);
    return {
        bundle: schemaSql === bundle.schemaSql && functionsSql === bundle.functionsSql
            ? bundle
            : { ...bundle, schemaSql, functionsSql },
        invalidFiles,
    };
}

function parsesWithoutErrors(core: DashQL, sql: string): boolean {
    const catalog = core.createCatalog();
    const script = core.createScript(catalog);
    let parsed: FlatBufferPtr<buffers.parser.ParsedScript> | null = null;
    try {
        script.replaceText(sql);
        script.parse();
        parsed = script.getParsed();
        const reader = parsed.read();
        return reader.scannerErrorsLength() === 0 && reader.parserErrorsLength() === 0;
    } catch {
        return false;
    } finally {
        parsed?.destroy();
        script.destroy();
        catalog.destroy();
    }
}

export interface SessionBundleWriteOptions {
    /// Destination UUID. When omitted, preserve the source session's authoritative UUID.
    targetSessionId?: string;
    /// Add " (copy)" to a nonblank source name. Intended for an explicit Create-new operation.
    suffixNameWithCopy?: boolean;
    /// The caller guarantees the destination did not exist before this write. Only then may a
    /// failed whole-bundle write remove the destination as rollback.
    targetIsFresh?: boolean;
    /// Generate fresh attached database identities for a clone/create-new import.
    regenerateDatabaseIds?: boolean;
}

/// Read the portable durable session data from a backend. Catalog SQL can be skipped for exports
/// that intentionally omit it; all other durable files are always loaded.
export async function readSessionBundle(
    sessionId: string,
    backend: StorageBackend,
    withCatalog: boolean = true,
): Promise<SessionBundle> {
    const [session, scripts, schemaSql, functionsSql] = await Promise.all([
        backend.loadSession(sessionId),
        backend.loadScripts(sessionId),
        withCatalog ? backend.loadSessionSchema(sessionId) : null,
        withCatalog ? backend.loadSessionFunctions(sessionId) : null,
    ]);
    const data = await Promise.all((await backend.listDataFiles(sessionId))
        .map(async file => ({ name: file.name, bytes: await backend.loadDataFile(sessionId, file.name) })));
    return { session, schemaSql, functionsSql, scripts, data };
}

/// Write a fully parsed bundle to storage. This is deliberately not a replacement transaction:
/// callers replacing an existing session must stage and coordinate that operation separately.
export async function writeSessionBundle(
    bundle: SessionBundle,
    backend: StorageBackend,
    options: SessionBundleWriteOptions = {},
): Promise<string> {
    const validation = validateSessionData(bundle.session);
    if (!validation.ok) {
        throw new Error(`Invalid source session: ${describeSessionValidationError(validation.error)}`);
    }
    const sessionId = options.targetSessionId ?? bundle.session.sessionId;
    if (!isValidUuid(sessionId)) {
        throw new Error(`Invalid target session id: ${sessionId}`);
    }
    if (options.targetIsFresh && options.targetSessionId == null) {
        throw new Error('targetIsFresh requires an explicit targetSessionId');
    }
    for (const file of bundle.data ?? []) validateDataFileName(file.name);

    let session: SessionData = {
        ...bundle.session,
        sessionId,
    };
    if (options.regenerateDatabaseIds) session = regenerateSessionDatabaseIds(session);
    if (backend.getBackendType() === StorageBackendType.OPFS) {
        delete session.sessionPath;
        delete session.storageType;
        delete session.nativePath;
    }
    if (options.suffixNameWithCopy) {
        const name = session.name?.trim();
        if (name) {
            session.name = `${name} (copy)`;
        }
    }

    try {
        await backend.saveSessionManifest(sessionId, session);
        const schemaSql = rebaseSessionAttachmentPaths(bundle.schemaSql, bundle.session.sessionId, sessionId);
        const functionsSql = rebaseSessionAttachmentPaths(bundle.functionsSql ?? '', bundle.session.sessionId, sessionId)!;
        if (schemaSql != null) {
            await backend.saveSessionSchema(sessionId, schemaSql);
        }
        await backend.saveSessionFunctions(sessionId, functionsSql);
        for (const script of bundle.scripts) {
            await backend.saveScript(sessionId, script.name,
                rebaseSessionAttachmentPaths(script.sql, bundle.session.sessionId, sessionId)!);
        }
        for (const file of bundle.data ?? []) {
            await backend.saveDataFile(sessionId, file.name, file.bytes);
        }
    } catch (error) {
        if (options.targetIsFresh) {
            try {
                await backend.deleteSession(sessionId);
            } catch {
                // Preserve the write error when best-effort rollback also fails.
            }
        }
        throw error;
    }

    return sessionId;
}

/// Compare all portable durable content. Used to verify a staged replacement before touching the
/// live session UUID.
export function sessionBundlesEqual(a: SessionBundle, b: SessionBundle): boolean {
    const { data: aData = [], ...aText } = a;
    const { data: bData = [], ...bText } = b;
    return JSON.stringify(aText) === JSON.stringify(bText)
        && aData.length === bData.length
        && aData.every((file, i) => file.name === bData[i].name
            && file.bytes.byteLength === bData[i].bytes.byteLength
            && file.bytes.every((byte, j) => byte === bData[i].bytes[j]));
}
