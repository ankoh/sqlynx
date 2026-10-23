import type { DashQL, FlatBufferPtr, buffers } from '@ankoh/dashql-core';
import type { DataFileData, SessionData, ScriptData, StorageBackend } from './storage_backend.js';
import { STORAGE_CATALOG_FUNCTIONS, STORAGE_CATALOG_RELATIONS, STORAGE_SESSION_FILE, StorageBackendType, validateDataFileName } from './storage_backend.js';
import type { MigrationFolder } from '../../migration/migration_folder.js';
import { migrateSessionFolder, SessionMigrationResult } from '../../migration/session_migration.js';
import {
    describeSessionValidationError,
    isValidUuid,
    SessionValidationError,
    validateSessionData,
} from './session_validation.js';
import { reconcileSessionScripts, remapSessionScripts, sanitizeSessionFiles, sessionAttachments } from './session_files.js';

/// The durable, portable subset of a session. Derived cache files and storage-location metadata
/// are intentionally not represented here.
export interface SessionBundle {
    /// The session file. Its script list names every script of `scripts` in feed order and its
    /// attachment list names every file of `data`.
    session: SessionData;
    /// The catalog relations
    schemaSql: string | null;
    /// The catalog functions
    functionsSql: string | null;
    /// The script files
    scripts: ScriptData[];
    /// The attachments
    data?: DataFileData[];
}

/// The top-level files of a session bundle
export interface SessionBundleHead extends Pick<SessionBundle, 'session' | 'schemaSql' | 'functionsSql'> {
    /// False when unusable entries were removed from the file lists of the session file
    filesValid: boolean;
}

/// Complete a bundle from its top-level files and the files of its folders.
///
/// The file lists of the session file are reconciled with the files: scripts without a file are
/// dropped and script files without an entry are appended with the main database.
export function assembleSessionBundle(
    head: Pick<SessionBundle, 'session' | 'schemaSql' | 'functionsSql'>,
    scripts: ScriptData[],
    data: DataFileData[] = [],
): SessionBundle {
    const reconciled = reconcileSessionScripts(head.session.scripts, scripts.map(script => script.name), head.session.defaultConnectionId);
    return {
        session: {
            ...head.session,
            scripts: reconciled.scripts,
            attachments: sessionAttachments(data.map(file => file.name)),
        },
        schemaSql: head.schemaSql,
        functionsSql: head.functionsSql,
        scripts,
        data,
    };
}

/// Reconcile the file lists of a stored session file with the stored files, writes the session file
/// only when the lists changed. Must not race with writes of the session file.
export async function reconcileStoredSessionFiles(backend: StorageBackend, sessionId: string): Promise<SessionData> {
    const [session, scripts, dataFiles] = await Promise.all([
        backend.loadSession(sessionId),
        backend.loadScripts(sessionId),
        backend.listDataFiles(sessionId),
    ]);
    const sanitized = sanitizeSessionFiles(session);
    const reconciled = reconcileSessionScripts(sanitized.scripts, scripts.map(script => script.name), session.defaultConnectionId);
    const attachments = sessionAttachments(dataFiles.map(file => file.name));
    const next: SessionData = { ...session, scripts: reconciled.scripts, attachments };
    if (!sanitized.valid || reconciled.changed || !sessionAttachmentsEqual(session.attachments, attachments)) {
        await backend.saveSessionManifest(sessionId, next);
    }
    return next;
}

/// Do two attachment lists name the same files in the same order?
function sessionAttachmentsEqual(a: SessionData['attachments'] | undefined, b: SessionData['attachments']): boolean {
    return a != null && a.length === b.length && a.every((file, i) => file.name === b[i].name);
}

/// Migrate the top-level files of a session to the current format and read them.
///
/// The folder is usually held in memory, e.g. the files of an import or an `OverlayFolder` over a
/// folder that must stay untouched. Errors start with `errorPrefix`, e.g. "Invalid ZIP".
export async function readSessionBundleHead(folder: MigrationFolder, errorPrefix: string): Promise<SessionBundleHead> {
    const migration = await migrateSessionFolder(folder);
    if (migration === SessionMigrationResult.Missing) {
        throw new Error(`${errorPrefix}: missing ${STORAGE_SESSION_FILE}`);
    }
    const text = await folder.readText(STORAGE_SESSION_FILE);
    if (text == null) {
        // Metadata of an unsupported version under an older name
        throw new Error(`${errorPrefix}: invalid ${STORAGE_SESSION_FILE}: ${describeSessionValidationError(SessionValidationError.UnsupportedFormatVersion)}`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`${errorPrefix}: invalid ${STORAGE_SESSION_FILE}`);
    }
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${errorPrefix}: invalid ${STORAGE_SESSION_FILE}`);
    }
    const parsedSession = parsed as SessionData;
    const validation = validateSessionData(parsedSession);
    if (!validation.ok) {
        throw new Error(`${errorPrefix}: invalid ${STORAGE_SESSION_FILE}: ${describeSessionValidationError(validation.error)}`);
    }
    const files = sanitizeSessionFiles(parsedSession);
    const session: SessionData = { ...parsedSession, scripts: files.scripts, attachments: files.attachments };
    const [schemaSql, functionsSql] = await Promise.all([
        folder.readText(STORAGE_CATALOG_RELATIONS),
        folder.readText(STORAGE_CATALOG_FUNCTIONS),
    ]);
    return { session, schemaSql, functionsSql, filesValid: files.valid };
}

export interface SessionCatalogValidationResult {
    bundle: SessionBundle;
    invalidFiles: Array<typeof STORAGE_CATALOG_RELATIONS | typeof STORAGE_CATALOG_FUNCTIONS>;
}

/// Give the connections of a session fresh ids, the default connection and the scripts follow them
export function regenerateSessionConnectionIds(session: SessionData): SessionData {
    const connectionIds = new Map(session.connections.map(connection => [connection.connectionId, crypto.randomUUID()]));
    return {
        ...session,
        defaultConnectionId: connectionIds.get(session.defaultConnectionId) ?? session.defaultConnectionId,
        connections: session.connections.map(connection => ({ ...connection, connectionId: connectionIds.get(connection.connectionId)! })),
        scripts: remapSessionScripts(session.scripts, connectionIds),
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
    /// Generate fresh connection identities for a clone/create-new import.
    regenerateConnectionIds?: boolean;
}

/// Read the portable durable session data from a backend. Catalog SQL can be skipped for exports
/// that intentionally omit it; all other durable files are always loaded.
export async function readSessionBundle(
    sessionId: string,
    backend: StorageBackend,
    withCatalog: boolean = true,
): Promise<SessionBundle> {
    const [stored, scripts, schemaSql, functionsSql] = await Promise.all([
        backend.loadSession(sessionId),
        backend.loadScripts(sessionId),
        withCatalog ? backend.loadSessionSchema(sessionId) : null,
        withCatalog ? backend.loadSessionFunctions(sessionId) : null,
    ]);
    const data = await Promise.all((await backend.listDataFiles(sessionId))
        .map(async file => ({ name: file.name, bytes: await backend.loadDataFile(sessionId, file.name) })));
    const files = sanitizeSessionFiles(stored);
    const session: SessionData = { ...stored, scripts: files.scripts, attachments: files.attachments };
    return assembleSessionBundle({ session, schemaSql, functionsSql }, scripts, data);
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
        scripts: reconcileSessionScripts(bundle.session.scripts ?? [], bundle.scripts.map(script => script.name),
            bundle.session.defaultConnectionId).scripts,
        attachments: sessionAttachments((bundle.data ?? []).map(file => file.name)),
    };
    if (options.regenerateConnectionIds) session = regenerateSessionConnectionIds(session);
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
