import type { DashQL } from '@ankoh/dashql-core';
import type { Logger } from '../../../platform/logger/logger.js';
import { stringifyError } from '../../../platform/logger/logger.js';
import { ProgressCounter } from '../../../utils/progress.js';
import type { AttachedDatabaseState } from '../connections/attached_database_state.js';
import { registerAttachedDatabase, type AttachedDatabaseRegistry, type SessionAttachedDatabases } from '../connections/attached_database_registry.js';
import type { SessionScripts, ScriptData } from '../scripts/session_scripts.js';
import { addSessionScriptsForConnection, type SessionScriptsRegistry } from '../scripts/session_scripts_registry.js';
import { createEmptyScriptData, destroySessionScripts, replaceScriptSessionText } from '../scripts/session_scripts.js';
import { decodeConnectionFromProto, restoreAttachedDatabaseState } from '../connections/connection_import.js';
import { CONNECTOR_TYPES, ConnectorType, type ConnectorInfo } from '../connections/connector_info.js';
import type { StorageBackend, SessionEntry, SessionData, SessionRegistryBackend, ConnectionEntry } from './storage_backend.js';
import { StorageBackendType, STORAGE_CATALOG_CHANGES, STORAGE_CATALOG_FUNCTIONS, STORAGE_CATALOG_RELATIONS, isSessionRegistryBackend } from './storage_backend.js';
import { connectionParamsEqual } from '../connections/connection_params.js';
import { dedupeAttachedDatabases, patchSessionConnection, upsertConnectionEntry } from './storage_writer.js';
import { validateSessionData, describeInvalidSession, isValidUuid, SessionValidationError, type InvalidSession } from './session_validation.js';
import { CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK } from '../connections/catalog_update_state.js';
import { beginCatalogBatch, invalidateCatalogBatch, publishCatalogBatch, type BatchProcessor, type CatalogBatchEntry } from '../connections/catalog_batch.js';
import { readSessionSettings, type SessionSettings } from '../scripts/session_settings.js';

const LOG_CTX = "app_state_loader";

export interface RestoredAppState {
    connectionStates: Map<string, AttachedDatabaseState>;
    attachedDatabasesBySession: Map<string, SessionAttachedDatabases>;
    connectionStatesByType: string[][];
    connectionSignatures: Map<string, string | null>;
    sessionScripts: Map<string, SessionScripts>;
    sessionScriptsByConnection: Map<string, string[]>;
    sessionScriptsByConnectionType: string[][];
    /// Sessions whose metadata failed validation and were refused a load (keyed by bare UUID).
    /// These never enter the connection/session maps; the session workbench surfaces them as
    /// invalid (blocked from opening, still deletable).
    invalidSessions: Map<string, InvalidSession>;
}

/// Thrown by `restoreSessionEntry` when a session's metadata fails the up-front validation gate.
///
/// Distinguished from an arbitrary restore error so the loader can record it as a (skipped)
/// invalid session and surface it in the UI, rather than counting it as a hard failure.
class InvalidSessionError extends Error {
    constructor(public readonly invalid: InvalidSession) {
        super(`invalid session ${invalid.sessionId}: ${invalid.error}`);
        this.name = 'InvalidSessionError';
    }
}

export interface AppStateRestorationProgress {
    restoreConnections: ProgressCounter;
    restoreCatalogs: ProgressCounter;
    restoreSessionScripts: ProgressCounter;
}

/// Restores session scripts from storage
async function restoreSessionScripts(
    core: DashQL,
    backend: StorageBackend,
    sessionId: string,
    databaseId: string,
    name: string | null,
    settings: SessionSettings,
    connectorInfo: ConnectorInfo,
    connectionCatalog: any,
    sessionMetadata: any,
    logger: Logger
): Promise<SessionScripts> {
    const scripts: Record<number, ScriptData> = {};

    try {
        logger.info("Loading scripts", { sessionId }, LOG_CTX);
        const storedScripts = await backend.loadScripts(sessionId);
        logger.info("Scripts loaded", {
            sessionId,
            scriptCount: storedScripts.length.toString()
        }, LOG_CTX);

        const scriptRefs: { [fileName: string]: { scriptId: number; fileName: string } } = {};
        for (const scriptFile of storedScripts) {
                const [scriptKey, scriptData] = createEmptyScriptData(
                    core,
                    connectionCatalog,
                    scriptFile.name,
                );
                scripts[scriptKey] = scriptData;

                // Set SQL content. Ordinary session scripts remain outdated until first use.
                replaceScriptSessionText(scriptData.scriptSession, scriptFile.sql);

                scriptRefs[scriptFile.name] = {
                    scriptId: scriptKey,
                    fileName: scriptFile.name,
                };
        }

        const initialFile = Object.keys(scriptRefs).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0] ?? '';

        const sessionScripts: SessionScripts = {
            instance: core,
            sessionId,
            name,
            settings,
            databaseId,
            sessionMetadata,
            connectorInfo,
            connectionCatalog,
            scripts,
            scriptRefs,
            scriptFocus: { fileName: initialFile },
            semanticUserFocus: null,
        };

        return sessionScripts;
    } catch (error) {
        for (const scriptData of Object.values(scripts)) {
            scriptData.completion?.buffer.destroy();
            scriptData.pendingDiff?.diffBuffer.destroy();
            scriptData.scriptSession.destroy();
        }
        throw error;
    }
}

/// The state that the restoration of connections and sessions shares.
///
/// Connections are entities of their own, the app manifest is their source of truth. They are
/// restored first, sessions then resolve their references against them. Sessions keep copies of
/// the connection params to stay self-contained, a copy that disagrees with the manifest is
/// rewritten, and a reference to an unknown connection registers the connection from the copy.
interface RestoreContext {
    /// The core instance
    core: DashQL;
    /// The storage backend
    backend: StorageBackend;
    /// The backend as registry, null if the backend doesn't own the connections
    registry: SessionRegistryBackend | null;
    /// The logger
    logger: Logger;
    /// The batch processor for catalog scripts
    processor?: BatchProcessor;
    /// The connections (connectionId -> state)
    connectionStates: Map<string, AttachedDatabaseState>;
    /// The connections by connector type
    connectionStatesByType: string[][];
    /// The connection signatures
    connectionSignatures: Map<string, string | null>;
    /// The connections that were consolidated into others (alias -> connectionId)
    aliases: Map<string, string>;
    /// The aliases of every connection (connectionId -> aliases)
    aliasesOf: Map<string, string[]>;
    /// The connections whose catalog is restored, sessions no longer seed them
    catalogsRestored: Set<string>;
    /// The connections that were registered while restoring sessions
    newConnections: Map<string, AttachedDatabaseState>;
    /// The writes that bring the stored state in line with the restored one
    pendingWrites: RestorePendingWrites;
}

/// The writes that bring the stored state in line with the restored one
interface RestorePendingWrites {
    /// Connections that sessions registered, they are missing in the app manifest
    connectionEntries: ConnectionEntry[];
    /// Catalog files of connections that were seeded from sessions
    connectionFiles: Array<{ connectionId: string; fileName: string; text: string }>;
    /// Sessions whose copies of connection params are stale
    sessionCopies: Array<{ sessionId: string; connectionId: string }>;
}

/// The catalog texts of a connection
interface CatalogTexts {
    /// The relations
    relations: string | null;
    /// The functions
    functions: string | null;
    /// The catalog changes of executed statements
    changes: string | null;
}

function createRestoreContext(core: DashQL, backend: StorageBackend, logger: Logger, processor: BatchProcessor | undefined, connectionSignatures: Map<string, string | null>): RestoreContext {
    return {
        core,
        backend,
        registry: isSessionRegistryBackend(backend) ? backend : null,
        logger,
        processor,
        connectionStates: new Map(),
        connectionStatesByType: CONNECTOR_TYPES.map(() => []),
        connectionSignatures,
        aliases: new Map(),
        aliasesOf: new Map(),
        catalogsRestored: new Set(),
        newConnections: new Map(),
        pendingWrites: { connectionEntries: [], connectionFiles: [], sessionCopies: [] },
    };
}

/// Restore the catalog of a connection from its persisted SQL.
/// Returns true if there was a catalog to restore.
async function restoreConnectionCatalog(
    ctx: RestoreContext,
    connectionState: AttachedDatabaseState,
    load: () => Promise<CatalogTexts>,
    logContext: Record<string, string>,
): Promise<boolean> {
    const validate = beginCatalogBatch(connectionState.catalog);
    const { relations, functions, changes } = await load();
    validate();
    const { catalog, catalogRelationScript, catalogFunctionScript } = connectionState;
    const catalogScripts: CatalogBatchEntry[] = [];
    if (relations && relations.trim().length > 0) {
        ctx.logger.info("Catalog schema loaded", { ...logContext, schemaLength: relations.length.toString() }, LOG_CTX);
        catalogScripts.push({ script: catalogRelationScript, text: relations, rank: CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK });
    }
    if (functions && functions.trim().length > 0) {
        ctx.logger.info("Catalog functions loaded", { ...logContext, functionsLength: functions.length.toString() }, LOG_CTX);
        catalogScripts.push({ script: catalogFunctionScript, text: functions, rank: CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK });
    }
    if (catalogScripts.length > 0) {
        await publishCatalogBatch(ctx.core, catalog, catalogScripts, { processor: ctx.processor }, validate);
        connectionState.catalogUpdates.restoredAt = new Date();
    }
    const hasChanges = changes != null && changes.trim().length > 0;
    if (hasChanges) {
        restoreCatalogChanges(connectionState, changes, ctx.logger, logContext);
    }
    return catalogScripts.length > 0 || hasChanges;
}

/// Restore a connection of the app manifest
async function restoreConnectionEntry(ctx: RestoreContext, entry: ConnectionEntry): Promise<void> {
    let state: AttachedDatabaseState;
    try {
        const [connectorInfo, details] = decodeConnectionFromProto(entry.params as any, entry.id);
        state = restoreAttachedDatabaseState(ctx.core, entry.id, connectorInfo, details, ctx.connectionSignatures, entry.paramsDraft);
    } catch (error) {
        // Sessions referencing the connection register it again from their copies
        ctx.logger.warn("Failed to restore connection", { connectionId: entry.id, error: stringifyError(error) }, LOG_CTX);
        return;
    }
    ctx.connectionStates.set(state.databaseId, state);
    ctx.connectionStatesByType[state.connectorInfo.connectorType].push(state.databaseId);
    for (const alias of entry.aliases ?? []) {
        ctx.aliases.set(alias, entry.id);
    }
    ctx.aliasesOf.set(entry.id, entry.aliases ?? []);

    const registry = ctx.registry!;
    try {
        const restored = await restoreConnectionCatalog(ctx, state, async () => {
            const [relations, functions, changes] = await Promise.all([
                registry.loadConnectionFile(entry.id, STORAGE_CATALOG_RELATIONS),
                registry.loadConnectionFile(entry.id, STORAGE_CATALOG_FUNCTIONS),
                registry.loadConnectionFile(entry.id, STORAGE_CATALOG_CHANGES),
            ]);
            return { relations, functions, changes };
        }, { connectionId: entry.id });
        if (restored) {
            ctx.catalogsRestored.add(entry.id);
        }
    } catch (error) {
        // Catalog restoration is non-critical - the connection is still usable
        ctx.logger.warn("Failed to restore connection catalog, will refresh on connect", {
            connectionId: entry.id,
            error: stringifyError(error),
        }, LOG_CTX);
    }
}

/// Resolve a session's reference to a connection.
/// The app manifest wins over the copy in the session, an unknown connection is registered from the copy.
function resolveSessionDatabase(ctx: RestoreContext, sessionId: string, database: SessionData['mainDatabase']): AttachedDatabaseState {
    const connectionId = ctx.aliases.get(database.databaseId) ?? database.databaseId;
    const known = ctx.connectionStates.get(connectionId);
    if (known != null) {
        if (connectionId !== database.databaseId || database.paramsDraft != null || !connectionParamsEqual(database.params, known.params)) {
            ctx.pendingWrites.sessionCopies.push({ sessionId, connectionId });
        }
        return known;
    }
    const [connectorInfo, details] = decodeConnectionFromProto(database.params as any, sessionId);
    const state = restoreAttachedDatabaseState(ctx.core, connectionId, connectorInfo, details, ctx.connectionSignatures, database.paramsDraft);
    ctx.connectionStates.set(state.databaseId, state);
    ctx.connectionStatesByType[connectorInfo.connectorType].push(state.databaseId);
    ctx.newConnections.set(state.databaseId, state);
    ctx.pendingWrites.connectionEntries.push({
        id: state.databaseId,
        params: state.params,
        ...(database.paramsDraft == null ? {} : { paramsDraft: database.paramsDraft }),
        createdAt: new Date().toISOString(),
    });
    if (database.paramsDraft != null) {
        // Drafts move into the app manifest
        ctx.pendingWrites.sessionCopies.push({ sessionId, connectionId });
    }
    return state;
}

/// Restores a single session (connection references + catalog + session)
async function restoreSessionEntry(
    ctx: RestoreContext,
    sessionEntry: SessionEntry,
    attachedDatabasesBySession: Map<string, SessionAttachedDatabases>,
    sessionScripts: Map<string, SessionScripts>,
    sessionScriptsByConnection: Map<string, string[]>,
    sessionScriptsByConnectionType: string[][],
    restoreConnections: ProgressCounter,
    restoreCatalogs: ProgressCounter,
    restoreSessionScriptsProgress: ProgressCounter,
    progressConsumer: (progress: AppStateRestorationProgress) => void,
): Promise<void> {
    const { backend, logger } = ctx;
    // The session UUID is the authoritative identity and the key the backend routes on. Gate it up
    // front: a manifest entry whose path is not a valid UUID can't be loaded (the backend would
    // build a bogus path and throw), so surface it as an invalid session rather than a hard failure.
    const sessionId = sessionEntry.path;
    if (!isValidUuid(sessionId)) {
        const invalid = describeInvalidSession(sessionEntry, SessionValidationError.InvalidSessionId, null);
        logger.warn("Refusing to load session with an invalid id", {
            sessionId,
            reason: invalid.error,
        }, LOG_CTX);
        throw new InvalidSessionError(invalid);
    }

    // Phase 1: Resolve the connections
    logger.info("Restoring connection", { sessionId }, LOG_CTX);
    const connectionStartTime = performance.now();
    restoreConnections.addStarted();
    progressConsumer({
        restoreConnections: restoreConnections.clone(),
        restoreCatalogs: restoreCatalogs.clone(),
        restoreSessionScripts: restoreSessionScriptsProgress.clone(),
    });

    const sessionData = await loadValidSession(backend, logger, sessionEntry);

    // Validation above guarantees the params map to a known connector
    const connectionState = resolveSessionDatabase(ctx, sessionId, sessionData.mainDatabase);
    const attachedConnectionStates = sessionData.attachedDatabases.map(database => resolveSessionDatabase(ctx, sessionId, database));
    const connectorInfo = connectionState.connectorInfo;
    attachedDatabasesBySession.set(sessionId, {
        mainDatabaseId: connectionState.databaseId,
        attachedDatabaseIds: dedupeAttachedDatabases(connectionState.databaseId, attachedConnectionStates).map(database => database.databaseId),
    });

    const connectionDuration = performance.now() - connectionStartTime;
    logger.info("Connection restored", {
        sessionId,
        connectorType: ConnectorType[connectorInfo.connectorType],
        durationMs: connectionDuration.toFixed(2)
    }, LOG_CTX);

    restoreConnections.addSucceeded();

    // Phase 2: Restore the main database catalog. The catalog of a connection is persisted with the
    // connection, the copy in the session only seeds connections whose catalog is unknown.
    logger.info("Restoring catalog", { sessionId }, LOG_CTX);
    const catalogStartTime = performance.now();
    restoreCatalogs.addStarted();
    progressConsumer({
        restoreConnections: restoreConnections.clone(),
        restoreCatalogs: restoreCatalogs.clone(),
        restoreSessionScripts: restoreSessionScriptsProgress.clone(),
    });

    const connectionId = connectionState.databaseId;
    if (ctx.catalogsRestored.has(connectionId)) {
        restoreCatalogs.addSucceeded();
    } else {
        try {
            let texts: CatalogTexts = { relations: null, functions: null, changes: null };
            logger.info("Loading catalog scripts", { sessionId }, LOG_CTX);
            const restored = await restoreConnectionCatalog(ctx, connectionState, async () => {
                const [relations, functions, changes] = await Promise.all([
                    backend.loadSessionSchema(sessionId),
                    backend.loadSessionFunctions(sessionId),
                    backend.loadSessionCatalogChanges(sessionId),
                ]);
                texts = { relations, functions, changes };
                return texts;
            }, { sessionId });
            if (restored) {
                ctx.catalogsRestored.add(connectionId);
                for (const [fileName, text] of [
                    [STORAGE_CATALOG_RELATIONS, texts.relations],
                    [STORAGE_CATALOG_FUNCTIONS, texts.functions],
                    [STORAGE_CATALOG_CHANGES, texts.changes],
                ] as const) {
                    if (text != null) ctx.pendingWrites.connectionFiles.push({ connectionId, fileName, text });
                }
                logger.info("Catalog scripts restored", {
                    sessionId,
                    durationMs: (performance.now() - catalogStartTime).toFixed(2)
                }, LOG_CTX);
            } else {
                logger.info("No catalog schema found for session", { sessionId }, LOG_CTX);
            }
            restoreCatalogs.addSucceeded();
        } catch (catalogError) {
            logger.warn("Failed to restore catalog, will refresh on connect", {
                sessionId,
                durationMs: (performance.now() - catalogStartTime).toFixed(2),
                error: stringifyError(catalogError)
            }, LOG_CTX);

            // Catalog restoration is non-critical - connection is still usable
            restoreCatalogs.addFailed();
        }
    }

    // Phase 3: Restore session scripts
    logger.info("Restoring session scripts", { sessionId }, LOG_CTX);
    const sessionScriptsStartTime = performance.now();
    restoreSessionScriptsProgress.addStarted();
    progressConsumer({
        restoreConnections: restoreConnections.clone(),
        restoreCatalogs: restoreCatalogs.clone(),
        restoreSessionScripts: restoreSessionScriptsProgress.clone(),
    });

    let restoredSessionScripts: SessionScripts | null = null;
    try {
        restoredSessionScripts = await restoreSessionScripts(
            ctx.core,
            backend,
            sessionId,
            connectionState.databaseId,
            sessionData.name?.trim() || null,
            readSessionSettings(sessionData.settings, connectorInfo),
            connectorInfo,
            connectionState.catalog,
            sessionData.metadata,
            logger
        );

        const sessionScriptsDuration = performance.now() - sessionScriptsStartTime;
        logger.info("Session scripts restored", {
            sessionId,
            scriptCount: Object.keys(restoredSessionScripts.scripts).length.toString(),
            durationMs: sessionScriptsDuration.toFixed(2)
        }, LOG_CTX);

        restoreSessionScriptsProgress.addSucceeded();
    } catch (sessionScriptsError) {
        const sessionScriptsDuration = performance.now() - sessionScriptsStartTime;

        logger.warn("Failed to restore session scripts", {
            sessionId,
            durationMs: sessionScriptsDuration.toFixed(2),
            error: stringifyError(sessionScriptsError),
            stack: (sessionScriptsError instanceof Error ? sessionScriptsError.stack : (sessionScriptsError as any)?.stack)?.substring(0, 500)
        }, LOG_CTX);

        restoreSessionScriptsProgress.addFailed();
    }

    if (restoredSessionScripts != null) {
        sessionScripts.set(sessionId, restoredSessionScripts);
        sessionScriptsByConnection.set(connectionState.databaseId, [...(sessionScriptsByConnection.get(connectionState.databaseId) ?? []), sessionId]);
        sessionScriptsByConnectionType[connectorInfo.connectorType].push(sessionId);
    }

    progressConsumer({
        restoreConnections: restoreConnections.clone(),
        restoreCatalogs: restoreCatalogs.clone(),
        restoreSessionScripts: restoreSessionScriptsProgress.clone(),
    });
}

/// Load a session and validate its metadata
async function loadValidSession(backend: StorageBackend, logger: Logger, sessionEntry: SessionEntry): Promise<SessionData> {
    const sessionId = sessionEntry.path;
    logger.info("Loading session data", { sessionId }, LOG_CTX);
    // The manifest registers this session, but its files may be gone (a native session whose folder
    // the user moved/deleted, or a corrupt/absent OPFS session). Treat a load failure the same as a
    // metadata rejection: surface it as an invalid session so the selector shows it blocked and
    // deletable, rather than letting it fall through to the loader's generic "failed to restore"
    // path — which logs an error on every launch and leaves the stale entry with no way to remove it.
    let sessionData: SessionData;
    try {
        sessionData = await backend.loadSession(sessionId);
    } catch (loadError) {
        const invalid = describeInvalidSession(sessionEntry, SessionValidationError.SessionUnreadable, null);
        logger.warn("Refusing to load session with unreadable files", {
            sessionId,
            reason: invalid.error,
            error: stringifyError(loadError),
        }, LOG_CTX);
        throw new InvalidSessionError(invalid);
    }

    // Fail-fast metadata validation: refuse to load a session whose metadata is structurally
    // unusable (unsupported format, no id, or invalid attached database). This runs
    // before any heavy restore work and surfaces the session as invalid in the selector rather than
    // letting it blow up mid-restore. Runtime hiccups (catalog/session) remain non-fatal below.
    const validation = validateSessionData(sessionData);
    if (!validation.ok) {
        const invalid = describeInvalidSession(sessionEntry, validation.error, sessionData);
        logger.warn("Refusing to load invalid session", {
            sessionId,
            reason: invalid.error,
        }, LOG_CTX);
        throw new InvalidSessionError(invalid);
    }
    logger.info("Session data loaded", { sessionId }, LOG_CTX);
    return sessionData;
}

/// Perform the writes that bring the stored state in line with the restored one.
/// Failures are logged, the next load attempts them again.
async function flushRestoreWrites(ctx: RestoreContext): Promise<void> {
    const { registry, logger, pendingWrites } = ctx;
    if (registry == null) return;
    try {
        if (pendingWrites.connectionEntries.length > 0) {
            await registry.updateConnections(connections => {
                let next = connections ?? [];
                for (const entry of pendingWrites.connectionEntries) {
                    next = upsertConnectionEntry(next, entry) ?? next;
                }
                return next;
            });
        }
        for (const { connectionId, fileName, text } of pendingWrites.connectionFiles) {
            await registry.saveConnectionFile(connectionId, fileName, text);
        }
    } catch (error) {
        logger.warn("Failed to persist restored connections", { error: stringifyError(error) }, LOG_CTX);
        return;
    }
    for (const { sessionId, connectionId } of pendingWrites.sessionCopies) {
        const connection = ctx.connectionStates.get(connectionId);
        if (connection == null) continue;
        try {
            const existing = await ctx.backend.loadSession(sessionId);
            const next = patchSessionConnection(existing, connectionId, connection.params, ctx.aliasesOf.get(connectionId) ?? []);
            if (next != null) {
                await ctx.backend.saveSessionManifest(sessionId, next);
            }
        } catch (error) {
            logger.warn("Failed to update the connection copy of a session", { sessionId, connectionId, error: stringifyError(error) }, LOG_CTX);
        }
    }
}

/// The connection references + session a single session restored into.
export interface RestoredSession {
    /// The session id
    sessionId: string;
    /// The connections the session registered, connections that were already live are not included
    databases: AttachedDatabaseState[];
    /// The connections the session references
    mapping: SessionAttachedDatabases;
    /// The session scripts
    sessionScripts: SessionScripts;
}

export function mergeRestoredSessionIntoConnections(
    reg: AttachedDatabaseRegistry,
    restored: RestoredSession,
): AttachedDatabaseRegistry {
    for (const database of restored.databases) {
        if (!reg.attachedDatabases.has(database.databaseId)) {
            registerAttachedDatabase(reg, database);
        }
    }
    reg.attachedDatabasesBySession.set(restored.sessionId, restored.mapping);
    return { ...reg };
}

export function mergeRestoredSessionIntoScripts(
    reg: SessionScriptsRegistry,
    restored: RestoredSession,
): SessionScriptsRegistry {
    reg.sessionScriptsMap.set(restored.sessionId, restored.sessionScripts);
    addSessionScriptsForConnection(reg, restored.sessionScripts.databaseId, restored.sessionId);
    reg.sessionScriptsByConnectionType[restored.sessionScripts.connectorInfo.connectorType].push(restored.sessionId);
    return { ...reg };
}

/// Apply the catalog changes of executed statements on top of the restored relation script.
/// Unreadable changes are dropped, the next catalog refresh describes the relations anyway.
function restoreCatalogChanges(connection: AttachedDatabaseState, changesSql: string, logger: Logger, logContext: Record<string, string>): void {
    try {
        connection.catalog.applyCatalogChangesSql(connection.catalogRelationScript.catalog_entry_id, CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK, changesSql);
        connection.catalogChangesSql = changesSql;
        logger.info("Catalog changes restored", { ...logContext, changesLength: changesSql.length.toString() }, LOG_CTX);
    } catch (error) {
        logger.warn("Failed to restore the catalog changes", { ...logContext, error: stringifyError(error) }, LOG_CTX);
    }
}

export function destroyRestoredSession(restored: RestoredSession): void {
    destroySessionScripts(restored.sessionScripts);
    for (const database of restored.databases) destroyRestoredConnection(database);
}

function destroyRestoredConnection(connection: AttachedDatabaseState): void {
    invalidateCatalogBatch(connection.catalog);
    connection.connectionSignature.signatures.delete(
        connection.connectionSignature.signatureString,
    );
    connection.catalog.dropDescriptor(connection.catalogRelationScript.catalog_entry_id);
    connection.catalog.dropDescriptor(connection.catalogFunctionScript.catalog_entry_id);
    connection.catalogRelationScript.destroy();
    connection.catalogFunctionScript.destroy();
    connection.catalog.destroy();
}

/// The live connections that a restored session resolves its references against
export type LiveConnections = Pick<AttachedDatabaseRegistry, 'attachedDatabases' | 'attachedDatabasesBySignature'>;

/// Restore a single, already-persisted session (connection references + catalog + session) and
/// return just that session's pieces.
///
/// This is the incremental counterpart to `restoreAppState`, used after a session is written to
/// storage at runtime (e.g. imported from a shared URL) so it can be merged into the already-live
/// registries without a full app reload. It reuses the exact same `restoreSessionEntry` path the boot
/// loader runs, so a URL-imported session is decoded and cataloged identically to one
/// loaded at startup. References to live connections reuse them, unknown connections are
/// registered and returned.
export async function restoreSingleSession(
    core: DashQL,
    backend: StorageBackend,
    logger: Logger,
    sessionId: string,
    live: LiveConnections,
    processor?: BatchProcessor,
): Promise<RestoredSession> {
    // A freshly imported session is implicitly OPFS-backed and keyed by its UUID; that's all the
    // manifest entry `restoreSessionEntry` needs to route the load.
    const sessionEntry: SessionEntry = { path: sessionId, storageType: StorageBackendType.OPFS };

    const ctx = createRestoreContext(core, backend, logger, processor, live.attachedDatabasesBySignature);
    for (const [connectionId, state] of live.attachedDatabases) {
        ctx.connectionStates.set(connectionId, state);
        ctx.catalogsRestored.add(connectionId);
    }
    if (ctx.registry != null) {
        for (const entry of (await ctx.registry.loadManifest()).connections ?? []) {
            for (const alias of entry.aliases ?? []) ctx.aliases.set(alias, entry.id);
            ctx.aliasesOf.set(entry.id, entry.aliases ?? []);
        }
    }
    const attachedDatabasesBySession = new Map<string, SessionAttachedDatabases>();
    const sessionScripts = new Map<string, SessionScripts>();
    const sessionScriptsByConnection = new Map<string, string[]>();
    const sessionScriptsByConnectionType: string[][] = CONNECTOR_TYPES.map(() => []);

    const noopConsumer = () => { };
    try {
        await restoreSessionEntry(
            ctx,
            sessionEntry,
            attachedDatabasesBySession,
            sessionScripts,
            sessionScriptsByConnection,
            sessionScriptsByConnectionType,
            new ProgressCounter(),
            new ProgressCounter(),
            new ProgressCounter(),
            noopConsumer,
        );
    } catch (error) {
        for (const database of ctx.newConnections.values()) destroyRestoredConnection(database);
        throw error;
    }

    const mapping = attachedDatabasesBySession.get(sessionId);
    const scripts = sessionScripts.get(sessionId) ?? null;
    if (mapping == null || !scripts) {
        for (const database of ctx.newConnections.values()) destroyRestoredConnection(database);
        throw new Error(`imported session ${sessionId} did not restore its scripts`);
    }
    await flushRestoreWrites(ctx);
    return {
        sessionId,
        databases: [...ctx.newConnections.values()],
        mapping,
        sessionScripts: scripts,
    };
}

/**
 * Restores complete application state from storage
 */
export async function restoreAppState(
    core: DashQL,
    backend: StorageBackend,
    logger: Logger,
    progressConsumer: (progress: AppStateRestorationProgress) => void,
    processor?: BatchProcessor,
): Promise<RestoredAppState> {
    logger.info("Starting app state restoration", {}, LOG_CTX);
    const startTime = performance.now();

    const ctx = createRestoreContext(core, backend, logger, processor, new Map());
    const attachedDatabasesBySession = new Map<string, SessionAttachedDatabases>();
    const sessionScripts = new Map<string, SessionScripts>();
    const sessionScriptsByConnection = new Map<string, string[]>();
    const invalidSessions = new Map<string, InvalidSession>();
    const sessionScriptsByConnectionType: string[][] = CONNECTOR_TYPES.map(() => []);

    // Initialize progress counters
    const restoreConnections = new ProgressCounter();
    const restoreCatalogs = new ProgressCounter();
    const restoreSessionScriptsProgress = new ProgressCounter();

    try {
        // Load manifest
        logger.info("Loading app manifest", {}, LOG_CTX);
        const manifestStartTime = performance.now();
        const sessionEntries = await backend.listSessions('dashql-manifest.json');
        let connectionEntries: ConnectionEntry[] = [];
        if (ctx.registry != null) {
            const manifest = await ctx.registry.loadManifest();
            connectionEntries = manifest.connections ?? [];
        }
        const manifestDuration = performance.now() - manifestStartTime;

        logger.info("Loaded app manifest", {
            sessionCount: sessionEntries.length.toString(),
            connectionCount: connectionEntries.length.toString(),
            durationMs: manifestDuration.toFixed(2)
        }, LOG_CTX);

        // Restore the connections before the sessions that reference them
        for (const entry of connectionEntries) {
            await restoreConnectionEntry(ctx, entry);
        }

        // Set totals.
        restoreConnections.addTotal(sessionEntries.length);
        restoreCatalogs.addTotal(sessionEntries.length);
        restoreSessionScriptsProgress.addTotal(sessionEntries.length);

        progressConsumer({
            restoreConnections: restoreConnections.clone(),
            restoreCatalogs: restoreCatalogs.clone(),
            restoreSessionScripts: restoreSessionScriptsProgress.clone(),
        });

        // Process each session
        logger.info("Restoring sessions", { count: sessionEntries.length.toString() }, LOG_CTX);
        for (let i = 0; i < sessionEntries.length; i++) {
            const sessionEntry = sessionEntries[i];
            const sessionStartTime = performance.now();

            try {
                logger.info("Restoring session", {
                    index: `${i + 1}/${sessionEntries.length}`,
                    sessionId: sessionEntry.path
                }, LOG_CTX);

                await restoreSessionEntry(
                    ctx,
                    sessionEntry,
                    attachedDatabasesBySession,
                    sessionScripts,
                    sessionScriptsByConnection,
                    sessionScriptsByConnectionType,
                    restoreConnections,
                    restoreCatalogs,
                    restoreSessionScriptsProgress,
                    progressConsumer,
                );

                try {
                    await backend.ensureSessionIndex?.(sessionEntry.path);
                } catch (error) {
                    // The index is a derived publication sidecar. A failure to backfill it must not
                    // prevent an otherwise valid session from loading.
                    logger.warn("Failed to ensure session index", {
                        sessionId: sessionEntry.path,
                        error: stringifyError(error),
                    }, LOG_CTX);
                }

                const sessionDuration = performance.now() - sessionStartTime;
                logger.info("Session restored", {
                    index: `${i + 1}/${sessionEntries.length}`,
                    sessionId: sessionEntry.path,
                    durationMs: sessionDuration.toFixed(2)
                }, LOG_CTX);
            } catch (error) {
                const sessionDuration = performance.now() - sessionStartTime;

                if (error instanceof InvalidSessionError) {
                    // Metadata validation refused this session up front. Record it so the selector
                    // can show it as invalid (blocked, deletable), and account it as *skipped*
                    // rather than *failed* — nothing was attempted, the metadata was simply
                    // unusable. The session contributed no connection/catalog/scripts/scripts.
                    invalidSessions.set(error.invalid.sessionId, error.invalid);
                    restoreConnections.addSkipped();
                    restoreCatalogs.addSkipped();
                    restoreSessionScriptsProgress.addSkipped();

                    progressConsumer({
                        restoreConnections: restoreConnections.clone(),
                        restoreCatalogs: restoreCatalogs.clone(),
                        restoreSessionScripts: restoreSessionScriptsProgress.clone(),
                    });
                    continue;
                }

                logger.warn("Failed to restore session", {
                    index: `${i + 1}/${sessionEntries.length}`,
                    sessionId: sessionEntry.path,
                    durationMs: sessionDuration.toFixed(2),
                    error: stringifyError(error)
                }, LOG_CTX);

                restoreConnections.addFailed();
                restoreCatalogs.addFailed();
                restoreSessionScriptsProgress.addFailed();
                progressConsumer({
                    restoreConnections: restoreConnections.clone(),
                    restoreCatalogs: restoreCatalogs.clone(),
                    restoreSessionScripts: restoreSessionScriptsProgress.clone(),
                });
            }
        }
    } catch (manifestError) {
        logger.warn("Failed to load manifest, starting with empty state", {
            error: stringifyError(manifestError)
        }, LOG_CTX);
    }

    await flushRestoreWrites(ctx);

    progressConsumer({
        restoreConnections: restoreConnections.clone(),
        restoreCatalogs: restoreCatalogs.clone(),
        restoreSessionScripts: restoreSessionScriptsProgress.clone(),
    });

    const totalDuration = performance.now() - startTime;
    logger.info("Finished loading app state", {
        connections: ctx.connectionStates.size.toString(),
        sessionScripts: sessionScripts.size.toString(),
        invalidSessions: invalidSessions.size.toString(),
        connectionsSucceeded: restoreConnections.succeeded.toString(),
        connectionsFailed: restoreConnections.failed.toString(),
        connectionsSkipped: restoreConnections.skipped.toString(),
        totalDurationMs: totalDuration.toFixed(2)
    }, LOG_CTX);

    return {
        connectionStates: ctx.connectionStates,
        attachedDatabasesBySession,
        connectionStatesByType: ctx.connectionStatesByType,
        connectionSignatures: ctx.connectionSignatures,
        sessionScripts,
        sessionScriptsByConnection,
        sessionScriptsByConnectionType,
        invalidSessions,
    };
}
