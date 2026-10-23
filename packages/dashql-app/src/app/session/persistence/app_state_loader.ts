import type { DashQL } from '@ankoh/dashql-core';
import type { Logger } from '../../../platform/logger/logger.js';
import { stringifyError } from '../../../platform/logger/logger.js';
import { ProgressCounter } from '../../../utils/progress.js';
import type { ConnectionState } from '../../connections/connection_state.js';
import { registerConnection, sessionConnectionFromState, type ConnectionRegistry } from '../../connections/connection_registry.js';
import type { SessionScripts, ScriptData } from '../scripts/session_scripts.js';
import { addSessionScriptsForConnection, type SessionScriptsRegistry } from '../scripts/session_scripts_registry.js';
import { createEmptyScriptData, destroySessionScripts, replaceScriptSessionText, scriptConnectionOf, sessionConnectionIds } from '../scripts/session_scripts.js';
import { connectionStateFromStorage, destroyUnregisteredConnection, restoreConnectionCatalog } from '../../connections/connection_restore.js';
import { CONNECTOR_TYPES, ConnectorType } from '../../connections/connector_info.js';
import type { StorageBackend, SessionEntry, SessionData, SessionRegistryBackend, ConnectionEntry, SessionConnection, SessionScript } from '../../storage/storage_backend.js';
import { StorageBackendType, defaultSessionConnection, isSessionRegistryBackend } from '../../storage/storage_backend.js';
import { connectionParamsEqual } from '../../connections/connection_params.js';
import { patchSessionConnection, upsertConnectionEntry } from '../../storage/storage_writer.js';
import { withSessionScripts } from '../../storage/session_files.js';
import { resolveSessionScripts, sessionScriptsResolutionChanged, type SessionConnectionResolver } from './session_script_connections.js';
import { validateSessionData, describeInvalidSession, isValidUuid, SessionValidationError, type InvalidSession } from '../../storage/session_validation.js';
import type { BatchProcessor } from '../../connections/catalog_batch.js';
import { readSessionSettings, type SessionSettings } from '../scripts/session_settings.js';

const LOG_CTX = "app_state_loader";

export interface RestoredAppState {
    connectionStates: Map<string, ConnectionState>;
    connectionStatesByType: string[][];
    sessionScripts: Map<string, SessionScripts>;
    sessionScriptsByConnection: Map<string, string[]>;
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

/// The progress counters of a restoration, every change is reported to the consumer
class RestoreProgress {
    /// The restored connections of the sessions
    readonly connections = new ProgressCounter();
    /// The restored catalogs of the sessions
    readonly catalogs = new ProgressCounter();
    /// The restored session scripts
    readonly sessionScripts = new ProgressCounter();

    constructor(private readonly consumer: (progress: AppStateRestorationProgress) => void) { }

    /// Report the current progress
    report(): void {
        this.consumer({
            restoreConnections: this.connections.clone(),
            restoreCatalogs: this.catalogs.clone(),
            restoreSessionScripts: this.sessionScripts.clone(),
        });
    }
}

/// Restores session scripts from storage
async function restoreSessionScripts(
    core: DashQL,
    backend: StorageBackend,
    sessionId: string,
    name: string | null,
    settings: SessionSettings,
    sessionData: SessionData,
    mainConnection: ConnectionState,
    resolveConnection: SessionConnectionResolver,
    logger: Logger
): Promise<{ sessionScripts: SessionScripts; session: SessionData }> {
    const scripts: Record<number, ScriptData> = {};

    try {
        logger.info("Loading scripts", { sessionId }, LOG_CTX);
        const storedScripts = await backend.loadScripts(sessionId);
        logger.info("Scripts loaded", {
            sessionId,
            scriptCount: storedScripts.length.toString()
        }, LOG_CTX);

        // The session file orders the scripts and names their connections
        const sqlByName = new Map(storedScripts.map(script => [script.name, script.sql]));
        const resolved = resolveSessionScripts(sessionData, storedScripts.map(script => script.name), mainConnection, resolveConnection,
            connectionId => logger.warn("Script references an unknown connection, using the default connection", { sessionId, connectionId }, LOG_CTX));
        const scriptRefs: { [fileName: string]: { scriptId: number; fileName: string } } = {};
        for (const entry of resolved.scripts) {
            const [scriptKey, created] = createEmptyScriptData(core, scriptConnectionOf(entry.connection), entry.name);
            const scriptData = entry.unresolvedConnectionId == null ? created : { ...created, unresolvedConnectionId: entry.unresolvedConnectionId };
            scripts[scriptKey] = scriptData;

            // Set SQL content. Ordinary session scripts remain outdated until first use.
            replaceScriptSessionText(scriptData.scriptSession, sqlByName.get(entry.name) ?? '');

            scriptRefs[entry.name] = {
                scriptId: scriptKey,
                fileName: entry.name,
            };
        }
        const scriptOrder = resolved.scripts.map(entry => entry.name);

        const sessionScripts: SessionScripts = {
            instance: core,
            sessionId,
            name,
            settings,
            connectionId: mainConnection.connectionId,
            sessionMetadata: sessionData.metadata,
            connectorInfo: mainConnection.connectorInfo,
            connectionCatalog: mainConnection.catalog,
            scripts,
            scriptRefs,
            scriptOrder,
            scriptFocus: { fileName: scriptOrder[0] ?? '' },
            semanticUserFocus: null,
        };

        return { sessionScripts, session: resolved.session };
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
    connectionStates: Map<string, ConnectionState>;
    /// The connections by connector type
    connectionStatesByType: string[][];
    /// The connections that were consolidated into others (alias -> connectionId)
    aliases: Map<string, string>;
    /// The aliases of every connection (connectionId -> aliases)
    aliasesOf: Map<string, string[]>;
    /// The connections whose catalog is restored or live
    catalogsRestored: Set<string>;
    /// The connections that were registered while restoring sessions
    newConnections: Map<string, ConnectionState>;
    /// The writes that bring the stored state in line with the restored one
    pendingWrites: RestorePendingWrites;
}

/// The writes that bring the stored state in line with the restored one
interface RestorePendingWrites {
    /// Connections that sessions registered, they are missing in the app manifest
    connectionEntries: ConnectionEntry[];
    /// Catalog files of connections that hold dropped relations or changes, they are cleared
    staleConnectionFiles: Array<{ connectionId: string; fileName: string }>;
    /// Sessions whose copies of connection params are stale
    sessionCopies: Array<{ sessionId: string; connectionId: string }>;
    /// Sessions whose script lists or connections disagree with the restored scripts
    sessionScriptLists: Array<{ sessionId: string; defaultConnectionId: string; scripts: SessionScript[]; connections: SessionConnection[] }>;
}

function createRestoreContext(core: DashQL, backend: StorageBackend, logger: Logger, processor: BatchProcessor | undefined): RestoreContext {
    return {
        core,
        backend,
        registry: isSessionRegistryBackend(backend) ? backend : null,
        logger,
        processor,
        connectionStates: new Map(),
        connectionStatesByType: CONNECTOR_TYPES.map(() => []),
        aliases: new Map(),
        aliasesOf: new Map(),
        catalogsRestored: new Set(),
        newConnections: new Map(),
        pendingWrites: { connectionEntries: [], staleConnectionFiles: [], sessionCopies: [], sessionScriptLists: [] },
    };
}

/// Restore a connection of the app manifest
async function restoreConnectionEntry(ctx: RestoreContext, entry: ConnectionEntry): Promise<void> {
    let state: ConnectionState;
    try {
        state = connectionStateFromStorage(ctx.core, entry.id, entry);
    } catch (error) {
        // Sessions referencing the connection register it again from their copies
        ctx.logger.warn("Failed to restore connection", { connectionId: entry.id, error: stringifyError(error) }, LOG_CTX);
        return;
    }
    ctx.connectionStates.set(state.connectionId, state);
    ctx.connectionStatesByType[state.connectorInfo.connectorType].push(state.connectionId);
    for (const alias of entry.aliases ?? []) {
        ctx.aliases.set(alias, entry.id);
    }
    ctx.aliasesOf.set(entry.id, entry.aliases ?? []);
    await restoreCatalog(ctx, ctx.registry!, state, { connectionId: entry.id });
}

/// Restore the catalog of a connection once, returns false if the restoration failed
async function restoreCatalog(
    ctx: RestoreContext,
    registry: SessionRegistryBackend,
    state: ConnectionState,
    logContext: Record<string, string>,
): Promise<boolean> {
    const connectionId = state.connectionId;
    ctx.catalogsRestored.add(connectionId);
    const restored = await restoreConnectionCatalog(ctx, registry, state, logContext);
    for (const fileName of restored.staleFiles) {
        ctx.pendingWrites.staleConnectionFiles.push({ connectionId, fileName });
    }
    return restored.succeeded;
}

/// Resolve a session's reference to a connection.
/// The app manifest wins over the copy in the session, an unknown connection is registered from the copy.
function resolveSessionConnection(ctx: RestoreContext, sessionId: string, database: SessionConnection): ConnectionState {
    const connectionId = ctx.aliases.get(database.connectionId) ?? database.connectionId;
    const known = ctx.connectionStates.get(connectionId);
    if (known != null) {
        if (connectionId !== database.connectionId || database.paramsDraft != null || !connectionParamsEqual(database.params, known.params)) {
            ctx.pendingWrites.sessionCopies.push({ sessionId, connectionId });
        }
        return known;
    }
    const state = connectionStateFromStorage(ctx.core, connectionId, database);
    ctx.connectionStates.set(state.connectionId, state);
    ctx.connectionStatesByType[state.connectorInfo.connectorType].push(state.connectionId);
    ctx.newConnections.set(state.connectionId, state);
    ctx.pendingWrites.connectionEntries.push({
        id: state.connectionId,
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
    sessionScripts: Map<string, SessionScripts>,
    sessionScriptsByConnection: Map<string, string[]>,
    progress: RestoreProgress,
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
    progress.connections.addStarted();
    progress.report();

    const sessionData = await loadValidSession(backend, logger, sessionEntry);

    // Validation above guarantees the params map to a known connector and the default connection to exist.
    // The other connections of the session are the connections of its scripts, they are resolved with the scripts.
    const connectionState = resolveSessionConnection(ctx, sessionId, defaultSessionConnection(sessionData));
    const connectorInfo = connectionState.connectorInfo;
    const resolveScriptConnection: SessionConnectionResolver = (connectionId, copy) => copy != null
        ? resolveSessionConnection(ctx, sessionId, copy)
        : ctx.connectionStates.get(ctx.aliases.get(connectionId) ?? connectionId) ?? null;

    const connectionDuration = performance.now() - connectionStartTime;
    logger.info("Connection restored", {
        sessionId,
        connectorType: ConnectorType[connectorInfo.connectorType],
        durationMs: connectionDuration.toFixed(2)
    }, LOG_CTX);

    progress.connections.addSucceeded();

    // Phase 2: Restore the catalog of a connection that the session registered. The connections of
    // the app manifest restored their catalogs already.
    logger.info("Restoring catalog", { sessionId }, LOG_CTX);
    progress.catalogs.addStarted();
    progress.report();
    if (ctx.registry == null || ctx.catalogsRestored.has(connectionState.connectionId)
        || await restoreCatalog(ctx, ctx.registry, connectionState, { sessionId, connectionId: connectionState.connectionId })) {
        progress.catalogs.addSucceeded();
    } else {
        progress.catalogs.addFailed();
    }

    // Phase 3: Restore session scripts
    logger.info("Restoring session scripts", { sessionId }, LOG_CTX);
    const sessionScriptsStartTime = performance.now();
    progress.sessionScripts.addStarted();
    progress.report();

    let restoredSessionScripts: SessionScripts | null = null;
    try {
        const restored = await restoreSessionScripts(
            ctx.core,
            backend,
            sessionId,
            sessionData.name?.trim() || null,
            readSessionSettings(sessionData.settings, connectorInfo),
            sessionData,
            connectionState,
            resolveScriptConnection,
            logger
        );
        restoredSessionScripts = restored.sessionScripts;
        if (sessionScriptsResolutionChanged(sessionData, restored.session)) {
            const { defaultConnectionId, scripts, connections } = restored.session;
            ctx.pendingWrites.sessionScriptLists.push({ sessionId, defaultConnectionId, scripts, connections });
        }

        const sessionScriptsDuration = performance.now() - sessionScriptsStartTime;
        logger.info("Session scripts restored", {
            sessionId,
            scriptCount: Object.keys(restoredSessionScripts.scripts).length.toString(),
            durationMs: sessionScriptsDuration.toFixed(2)
        }, LOG_CTX);

        progress.sessionScripts.addSucceeded();
    } catch (sessionScriptsError) {
        const sessionScriptsDuration = performance.now() - sessionScriptsStartTime;

        logger.warn("Failed to restore session scripts", {
            sessionId,
            durationMs: sessionScriptsDuration.toFixed(2),
            error: stringifyError(sessionScriptsError),
            stack: (sessionScriptsError instanceof Error ? sessionScriptsError.stack : (sessionScriptsError as any)?.stack)?.substring(0, 500)
        }, LOG_CTX);

        progress.sessionScripts.addFailed();
    }

    if (restoredSessionScripts != null) {
        sessionScripts.set(sessionId, restoredSessionScripts);
        for (const id of sessionConnectionIds(restoredSessionScripts)) {
            sessionScriptsByConnection.set(id, [...(sessionScriptsByConnection.get(id) ?? []), sessionId]);
        }
    }

    progress.report();
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
    // unusable (unsupported format, no id, or invalid connection). This runs
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
    const { registry, pendingWrites } = ctx;
    if (registry != null) {
        await flushRestoredConnectionWrites(ctx, registry);
    }
    for (const { sessionId, defaultConnectionId, scripts, connections } of pendingWrites.sessionScriptLists) {
        await patchRestoredSession(ctx, sessionId, session => {
            const next = withSessionScripts({ ...session, defaultConnectionId }, scripts, connections);
            return sessionScriptsResolutionChanged(session, next) ? next : null;
        });
    }
}

/// Patch the file of a restored session, a failure is logged and the next load attempts it again
async function patchRestoredSession(ctx: RestoreContext, sessionId: string, patch: (session: SessionData) => SessionData | null): Promise<void> {
    try {
        const next = patch(await ctx.backend.loadSession(sessionId));
        if (next != null) {
            await ctx.backend.saveSessionManifest(sessionId, next);
        }
    } catch (error) {
        ctx.logger.warn("Failed to update a restored session", { sessionId, error: stringifyError(error) }, LOG_CTX);
    }
}

/// Persist the connections that the restoration registered or consolidated
async function flushRestoredConnectionWrites(ctx: RestoreContext, registry: SessionRegistryBackend): Promise<void> {
    const { logger, pendingWrites } = ctx;
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
        for (const { connectionId, fileName } of pendingWrites.staleConnectionFiles) {
            await registry.saveConnectionFile(connectionId, fileName, '');
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
            const next = patchSessionConnection(existing, sessionConnectionFromState(connection), ctx.aliasesOf.get(connectionId) ?? []);
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
    databases: ConnectionState[];
    /// The session scripts
    sessionScripts: SessionScripts;
}

export function mergeRestoredSessionIntoConnections(
    reg: ConnectionRegistry,
    restored: RestoredSession,
): ConnectionRegistry {
    for (const database of restored.databases) {
        if (!reg.connections.has(database.connectionId)) {
            registerConnection(reg, database);
        }
    }
    return { ...reg };
}

export function mergeRestoredSessionIntoScripts(
    reg: SessionScriptsRegistry,
    restored: RestoredSession,
): SessionScriptsRegistry {
    reg.sessionScriptsMap.set(restored.sessionId, restored.sessionScripts);
    for (const connectionId of sessionConnectionIds(restored.sessionScripts)) {
        addSessionScriptsForConnection(reg, connectionId, restored.sessionId);
    }
    return { ...reg };
}

export function destroyRestoredSession(restored: RestoredSession): void {
    destroySessionScripts(restored.sessionScripts);
    for (const database of restored.databases) destroyUnregisteredConnection(database);
}

/// The live connections that a restored session resolves its references against
export type LiveConnections = Pick<ConnectionRegistry, 'connections'>;

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

    const ctx = createRestoreContext(core, backend, logger, processor);
    for (const [connectionId, state] of live.connections) {
        ctx.connectionStates.set(connectionId, state);
        ctx.catalogsRestored.add(connectionId);
    }
    if (ctx.registry != null) {
        for (const entry of (await ctx.registry.loadManifest()).connections ?? []) {
            for (const alias of entry.aliases ?? []) ctx.aliases.set(alias, entry.id);
            ctx.aliasesOf.set(entry.id, entry.aliases ?? []);
        }
    }
    const sessionScripts = new Map<string, SessionScripts>();
    const sessionScriptsByConnection = new Map<string, string[]>();

    try {
        await restoreSessionEntry(
            ctx,
            sessionEntry,
            sessionScripts,
            sessionScriptsByConnection,
            new RestoreProgress(() => { }),
        );
    } catch (error) {
        for (const database of ctx.newConnections.values()) destroyUnregisteredConnection(database);
        throw error;
    }

    const scripts = sessionScripts.get(sessionId) ?? null;
    if (!scripts) {
        for (const database of ctx.newConnections.values()) destroyUnregisteredConnection(database);
        throw new Error(`imported session ${sessionId} did not restore its scripts`);
    }
    await flushRestoreWrites(ctx);
    return {
        sessionId,
        databases: [...ctx.newConnections.values()],
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

    const ctx = createRestoreContext(core, backend, logger, processor);
    const sessionScripts = new Map<string, SessionScripts>();
    const sessionScriptsByConnection = new Map<string, string[]>();
    const invalidSessions = new Map<string, InvalidSession>();

    const progress = new RestoreProgress(progressConsumer);

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
        progress.connections.addTotal(sessionEntries.length);
        progress.catalogs.addTotal(sessionEntries.length);
        progress.sessionScripts.addTotal(sessionEntries.length);

        progress.report();

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
                    sessionScripts,
                    sessionScriptsByConnection,
                    progress,
                );

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
                    progress.connections.addSkipped();
                    progress.catalogs.addSkipped();
                    progress.sessionScripts.addSkipped();

                    progress.report();
                    continue;
                }

                logger.warn("Failed to restore session", {
                    index: `${i + 1}/${sessionEntries.length}`,
                    sessionId: sessionEntry.path,
                    durationMs: sessionDuration.toFixed(2),
                    error: stringifyError(error)
                }, LOG_CTX);

                progress.connections.addFailed();
                progress.catalogs.addFailed();
                progress.sessionScripts.addFailed();
                progress.report();
            }
        }
    } catch (manifestError) {
        logger.warn("Failed to load manifest, starting with empty state", {
            error: stringifyError(manifestError)
        }, LOG_CTX);
    }

    await flushRestoreWrites(ctx);

    progress.report();

    const totalDuration = performance.now() - startTime;
    logger.info("Finished loading app state", {
        connections: ctx.connectionStates.size.toString(),
        sessionScripts: sessionScripts.size.toString(),
        invalidSessions: invalidSessions.size.toString(),
        connectionsSucceeded: progress.connections.succeeded.toString(),
        connectionsFailed: progress.connections.failed.toString(),
        connectionsSkipped: progress.connections.skipped.toString(),
        totalDurationMs: totalDuration.toFixed(2)
    }, LOG_CTX);

    return {
        connectionStates: ctx.connectionStates,
        connectionStatesByType: ctx.connectionStatesByType,
        sessionScripts,
        sessionScriptsByConnection,
        invalidSessions,
    };
}
