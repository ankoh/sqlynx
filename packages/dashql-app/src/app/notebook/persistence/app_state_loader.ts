import type { DashQL } from '@ankoh/dashql-core';
import type { Logger } from '../../../platform/logger/logger.js';
import { stringifyError } from '../../../platform/logger/logger.js';
import { ProgressCounter } from '../../../utils/progress.js';
import type { AttachedDatabaseState } from '../connections/attached_database_state.js';
import { registerAttachedDatabase, type AttachedDatabaseRegistry, type NotebookAttachedDatabases } from '../connections/attached_database_registry.js';
import type { NotebookScripts, ScriptData } from '../scripts/notebook_scripts.js';
import { addNotebookScriptsForConnection, type NotebookScriptsRegistry } from '../scripts/notebook_scripts_registry.js';
import { createEmptyScriptData, destroyNotebookScripts, replaceScriptSessionText } from '../scripts/notebook_scripts.js';
import { decodeConnectionFromProto, restoreAttachedDatabaseState } from '../connections/connection_import.js';
import { CONNECTOR_TYPES, ConnectorType, type ConnectorInfo } from '../connections/connector_info.js';
import type { StorageBackend, NotebookEntry, NotebookData, NotebookRegistryBackend, ConnectionEntry } from './storage_backend.js';
import { StorageBackendType, STORAGE_CATALOG_CHANGES, STORAGE_CATALOG_FUNCTIONS, STORAGE_CATALOG_RELATIONS, isNotebookRegistryBackend } from './storage_backend.js';
import { connectionParamsEqual } from '../connections/connection_params.js';
import { dedupeAttachedDatabases, patchNotebookConnection, upsertConnectionEntry } from './storage_writer.js';
import { applyConnectionMigration, planConnectionMigration, type MigratingNotebook } from './connection_migration.js';
import { validateNotebookData, describeInvalidNotebook, isValidUuid, NotebookValidationError, type InvalidNotebook } from './notebook_validation.js';
import { CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK } from '../connections/catalog_update_state.js';
import { beginCatalogBatch, invalidateCatalogBatch, publishCatalogBatch, type BatchProcessor, type CatalogBatchEntry } from '../connections/catalog_batch.js';
import { readNotebookSettings, type NotebookSettings } from '../scripts/notebook_settings.js';

const LOG_CTX = "app_state_loader";

export interface RestoredAppState {
    connectionStates: Map<string, AttachedDatabaseState>;
    attachedDatabasesByNotebook: Map<string, NotebookAttachedDatabases>;
    connectionStatesByType: string[][];
    connectionSignatures: Map<string, string | null>;
    notebookScripts: Map<string, NotebookScripts>;
    notebookScriptsByConnection: Map<string, string[]>;
    notebookScriptsByConnectionType: string[][];
    /// Notebooks whose metadata failed validation and were refused a load (keyed by bare UUID).
    /// These never enter the connection/notebook maps; the notebook workbench surfaces them as
    /// invalid (blocked from opening, still deletable).
    invalidNotebooks: Map<string, InvalidNotebook>;
}

/// Thrown by `restoreNotebookEntry` when a notebook's metadata fails the up-front validation gate.
///
/// Distinguished from an arbitrary restore error so the loader can record it as a (skipped)
/// invalid notebook and surface it in the UI, rather than counting it as a hard failure.
class InvalidNotebookError extends Error {
    constructor(public readonly invalid: InvalidNotebook) {
        super(`invalid notebook ${invalid.notebookId}: ${invalid.error}`);
        this.name = 'InvalidNotebookError';
    }
}

export interface AppStateRestorationProgress {
    restoreConnections: ProgressCounter;
    restoreCatalogs: ProgressCounter;
    restoreNotebookScripts: ProgressCounter;
}

/// Restores notebook scripts from storage
async function restoreNotebookScripts(
    core: DashQL,
    backend: StorageBackend,
    notebookId: string,
    databaseId: string,
    name: string | null,
    settings: NotebookSettings,
    connectorInfo: ConnectorInfo,
    connectionCatalog: any,
    notebookMetadata: any,
    logger: Logger
): Promise<NotebookScripts> {
    const scripts: Record<number, ScriptData> = {};

    try {
        logger.info("Loading scripts", { notebookId }, LOG_CTX);
        const storedScripts = await backend.loadScripts(notebookId);
        logger.info("Scripts loaded", {
            notebookId,
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

                // Set SQL content. Ordinary notebook scripts remain outdated until first use.
                replaceScriptSessionText(scriptData.scriptSession, scriptFile.sql);

                scriptRefs[scriptFile.name] = {
                    scriptId: scriptKey,
                    fileName: scriptFile.name,
                };
        }

        const initialFile = Object.keys(scriptRefs).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0] ?? '';

        const notebookScripts: NotebookScripts = {
            instance: core,
            notebookId,
            name,
            settings,
            databaseId,
            notebookMetadata,
            connectorInfo,
            connectionCatalog,
            scripts,
            scriptRefs,
            scriptFocus: { fileName: initialFile },
            semanticUserFocus: null,
        };

        return notebookScripts;
    } catch (error) {
        for (const scriptData of Object.values(scripts)) {
            scriptData.completion?.buffer.destroy();
            scriptData.pendingDiff?.diffBuffer.destroy();
            scriptData.scriptSession.destroy();
        }
        throw error;
    }
}

/// The state that the restoration of connections and notebooks shares.
///
/// Connections are entities of their own, the app manifest is their source of truth. They are
/// restored first, notebooks then resolve their references against them. Notebooks keep copies of
/// the connection params to stay self-contained, a copy that disagrees with the manifest is
/// rewritten, and a reference to an unknown connection registers the connection from the copy.
interface RestoreContext {
    /// The core instance
    core: DashQL;
    /// The storage backend
    backend: StorageBackend;
    /// The backend as registry, null if the backend doesn't own the connections
    registry: NotebookRegistryBackend | null;
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
    /// The connections whose catalog is restored, notebooks no longer seed them
    catalogsRestored: Set<string>;
    /// The connections that were registered while restoring notebooks
    newConnections: Map<string, AttachedDatabaseState>;
    /// The writes that bring the stored state in line with the restored one
    pendingWrites: RestorePendingWrites;
}

/// The writes that bring the stored state in line with the restored one
interface RestorePendingWrites {
    /// Connections that notebooks registered, they are missing in the app manifest
    connectionEntries: ConnectionEntry[];
    /// Catalog files of connections that were seeded from notebooks
    connectionFiles: Array<{ connectionId: string; fileName: string; text: string }>;
    /// Notebooks whose copies of connection params are stale
    notebookCopies: Array<{ notebookId: string; connectionId: string }>;
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
        registry: isNotebookRegistryBackend(backend) ? backend : null,
        logger,
        processor,
        connectionStates: new Map(),
        connectionStatesByType: CONNECTOR_TYPES.map(() => []),
        connectionSignatures,
        aliases: new Map(),
        aliasesOf: new Map(),
        catalogsRestored: new Set(),
        newConnections: new Map(),
        pendingWrites: { connectionEntries: [], connectionFiles: [], notebookCopies: [] },
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
        // Notebooks referencing the connection register it again from their copies
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

/// Resolve a notebook's reference to a connection.
/// The app manifest wins over the copy in the notebook, an unknown connection is registered from the copy.
function resolveNotebookDatabase(ctx: RestoreContext, notebookId: string, database: NotebookData['mainDatabase']): AttachedDatabaseState {
    const connectionId = ctx.aliases.get(database.databaseId) ?? database.databaseId;
    const known = ctx.connectionStates.get(connectionId);
    if (known != null) {
        if (connectionId !== database.databaseId || database.paramsDraft != null || !connectionParamsEqual(database.params, known.params)) {
            ctx.pendingWrites.notebookCopies.push({ notebookId, connectionId });
        }
        return known;
    }
    const [connectorInfo, details] = decodeConnectionFromProto(database.params as any, notebookId);
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
        ctx.pendingWrites.notebookCopies.push({ notebookId, connectionId });
    }
    return state;
}

/// Restores a single notebook (connection references + catalog + notebook)
async function restoreNotebookEntry(
    ctx: RestoreContext,
    notebookEntry: NotebookEntry,
    attachedDatabasesByNotebook: Map<string, NotebookAttachedDatabases>,
    notebookScripts: Map<string, NotebookScripts>,
    notebookScriptsByConnection: Map<string, string[]>,
    notebookScriptsByConnectionType: string[][],
    restoreConnections: ProgressCounter,
    restoreCatalogs: ProgressCounter,
    restoreNotebookScriptsProgress: ProgressCounter,
    progressConsumer: (progress: AppStateRestorationProgress) => void,
): Promise<void> {
    const { backend, logger } = ctx;
    // The notebook UUID is the authoritative identity and the key the backend routes on. Gate it up
    // front: a manifest entry whose path is not a valid UUID can't be loaded (the backend would
    // build a bogus path and throw), so surface it as an invalid notebook rather than a hard failure.
    const notebookId = notebookEntry.path;
    if (!isValidUuid(notebookId)) {
        const invalid = describeInvalidNotebook(notebookEntry, NotebookValidationError.InvalidNotebookId, null);
        logger.warn("Refusing to load notebook with an invalid id", {
            notebookId,
            reason: invalid.error,
        }, LOG_CTX);
        throw new InvalidNotebookError(invalid);
    }

    // Phase 1: Resolve the connections
    logger.info("Restoring connection", { notebookId }, LOG_CTX);
    const connectionStartTime = performance.now();
    restoreConnections.addStarted();
    progressConsumer({
        restoreConnections: restoreConnections.clone(),
        restoreCatalogs: restoreCatalogs.clone(),
        restoreNotebookScripts: restoreNotebookScriptsProgress.clone(),
    });

    const notebookData = await loadValidNotebook(backend, logger, notebookEntry);

    // Validation above guarantees the params map to a known connector
    const connectionState = resolveNotebookDatabase(ctx, notebookId, notebookData.mainDatabase);
    const attachedConnectionStates = notebookData.attachedDatabases.map(database => resolveNotebookDatabase(ctx, notebookId, database));
    const connectorInfo = connectionState.connectorInfo;
    attachedDatabasesByNotebook.set(notebookId, {
        mainDatabaseId: connectionState.databaseId,
        attachedDatabaseIds: dedupeAttachedDatabases(connectionState.databaseId, attachedConnectionStates).map(database => database.databaseId),
    });

    const connectionDuration = performance.now() - connectionStartTime;
    logger.info("Connection restored", {
        notebookId,
        connectorType: ConnectorType[connectorInfo.connectorType],
        durationMs: connectionDuration.toFixed(2)
    }, LOG_CTX);

    restoreConnections.addSucceeded();

    // Phase 2: Restore the main database catalog. The catalog of a connection is persisted with the
    // connection, the copy in the notebook only seeds connections whose catalog is unknown.
    logger.info("Restoring catalog", { notebookId }, LOG_CTX);
    const catalogStartTime = performance.now();
    restoreCatalogs.addStarted();
    progressConsumer({
        restoreConnections: restoreConnections.clone(),
        restoreCatalogs: restoreCatalogs.clone(),
        restoreNotebookScripts: restoreNotebookScriptsProgress.clone(),
    });

    const connectionId = connectionState.databaseId;
    if (ctx.catalogsRestored.has(connectionId)) {
        restoreCatalogs.addSucceeded();
    } else {
        try {
            let texts: CatalogTexts = { relations: null, functions: null, changes: null };
            logger.info("Loading catalog scripts", { notebookId }, LOG_CTX);
            const restored = await restoreConnectionCatalog(ctx, connectionState, async () => {
                const [relations, functions, changes] = await Promise.all([
                    backend.loadNotebookSchema(notebookId),
                    backend.loadNotebookFunctions(notebookId),
                    backend.loadNotebookCatalogChanges(notebookId),
                ]);
                texts = { relations, functions, changes };
                return texts;
            }, { notebookId });
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
                    notebookId,
                    durationMs: (performance.now() - catalogStartTime).toFixed(2)
                }, LOG_CTX);
            } else {
                logger.info("No catalog schema found for notebook", { notebookId }, LOG_CTX);
            }
            restoreCatalogs.addSucceeded();
        } catch (catalogError) {
            logger.warn("Failed to restore catalog, will refresh on connect", {
                notebookId,
                durationMs: (performance.now() - catalogStartTime).toFixed(2),
                error: stringifyError(catalogError)
            }, LOG_CTX);

            // Catalog restoration is non-critical - connection is still usable
            restoreCatalogs.addFailed();
        }
    }

    // Phase 3: Restore notebook scripts
    logger.info("Restoring notebook scripts", { notebookId }, LOG_CTX);
    const notebookScriptsStartTime = performance.now();
    restoreNotebookScriptsProgress.addStarted();
    progressConsumer({
        restoreConnections: restoreConnections.clone(),
        restoreCatalogs: restoreCatalogs.clone(),
        restoreNotebookScripts: restoreNotebookScriptsProgress.clone(),
    });

    let restoredNotebookScripts: NotebookScripts | null = null;
    try {
        restoredNotebookScripts = await restoreNotebookScripts(
            ctx.core,
            backend,
            notebookId,
            connectionState.databaseId,
            notebookData.name?.trim() || null,
            readNotebookSettings(notebookData.settings, connectorInfo),
            connectorInfo,
            connectionState.catalog,
            notebookData.metadata,
            logger
        );

        const notebookScriptsDuration = performance.now() - notebookScriptsStartTime;
        logger.info("Notebook scripts restored", {
            notebookId,
            scriptCount: Object.keys(restoredNotebookScripts.scripts).length.toString(),
            durationMs: notebookScriptsDuration.toFixed(2)
        }, LOG_CTX);

        restoreNotebookScriptsProgress.addSucceeded();
    } catch (notebookScriptsError) {
        const notebookScriptsDuration = performance.now() - notebookScriptsStartTime;

        logger.warn("Failed to restore notebook scripts", {
            notebookId,
            durationMs: notebookScriptsDuration.toFixed(2),
            error: stringifyError(notebookScriptsError),
            stack: (notebookScriptsError instanceof Error ? notebookScriptsError.stack : (notebookScriptsError as any)?.stack)?.substring(0, 500)
        }, LOG_CTX);

        restoreNotebookScriptsProgress.addFailed();
    }

    if (restoredNotebookScripts != null) {
        notebookScripts.set(notebookId, restoredNotebookScripts);
        notebookScriptsByConnection.set(connectionState.databaseId, [...(notebookScriptsByConnection.get(connectionState.databaseId) ?? []), notebookId]);
        notebookScriptsByConnectionType[connectorInfo.connectorType].push(notebookId);
    }

    progressConsumer({
        restoreConnections: restoreConnections.clone(),
        restoreCatalogs: restoreCatalogs.clone(),
        restoreNotebookScripts: restoreNotebookScriptsProgress.clone(),
    });
}

/// Load a notebook and validate its metadata
async function loadValidNotebook(backend: StorageBackend, logger: Logger, notebookEntry: NotebookEntry): Promise<NotebookData> {
    const notebookId = notebookEntry.path;
    logger.info("Loading notebook data", { notebookId }, LOG_CTX);
    // The manifest registers this notebook, but its files may be gone (a native notebook whose folder
    // the user moved/deleted, or a corrupt/absent OPFS notebook). Treat a load failure the same as a
    // metadata rejection: surface it as an invalid notebook so the selector shows it blocked and
    // deletable, rather than letting it fall through to the loader's generic "failed to restore"
    // path — which logs an error on every launch and leaves the stale entry with no way to remove it.
    let notebookData: NotebookData;
    try {
        notebookData = await backend.loadNotebook(notebookId);
    } catch (loadError) {
        const invalid = describeInvalidNotebook(notebookEntry, NotebookValidationError.NotebookUnreadable, null);
        logger.warn("Refusing to load notebook with unreadable files", {
            notebookId,
            reason: invalid.error,
            error: stringifyError(loadError),
        }, LOG_CTX);
        throw new InvalidNotebookError(invalid);
    }

    // Fail-fast metadata validation: refuse to load a notebook whose metadata is structurally
    // unusable (unsupported format, no id, or invalid attached database). This runs
    // before any heavy restore work and surfaces the notebook as invalid in the selector rather than
    // letting it blow up mid-restore. Runtime hiccups (catalog/notebook) remain non-fatal below.
    const validation = validateNotebookData(notebookData);
    if (!validation.ok) {
        const invalid = describeInvalidNotebook(notebookEntry, validation.error, notebookData);
        logger.warn("Refusing to load invalid notebook", {
            notebookId,
            reason: invalid.error,
        }, LOG_CTX);
        throw new InvalidNotebookError(invalid);
    }
    logger.info("Notebook data loaded", { notebookId }, LOG_CTX);
    return notebookData;
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
    for (const { notebookId, connectionId } of pendingWrites.notebookCopies) {
        const connection = ctx.connectionStates.get(connectionId);
        if (connection == null) continue;
        try {
            const existing = await ctx.backend.loadNotebook(notebookId);
            const next = patchNotebookConnection(existing, connectionId, connection.params, ctx.aliasesOf.get(connectionId) ?? []);
            if (next != null) {
                await ctx.backend.saveNotebookManifest(notebookId, next);
            }
        } catch (error) {
            logger.warn("Failed to update the connection copy of a notebook", { notebookId, connectionId, error: stringifyError(error) }, LOG_CTX);
        }
    }
}

/// Make the connections of notebooks global, once.
/// Notebooks of older versions own their connections, the migration moves them into the app manifest
/// and consolidates connections with equal params.
async function migrateConnections(registry: NotebookRegistryBackend, notebookEntries: NotebookEntry[], logger: Logger): Promise<void> {
    const notebooks: MigratingNotebook[] = [];
    for (const entry of notebookEntries) {
        if (!isValidUuid(entry.path)) continue;
        try {
            const data = await registry.loadNotebook(entry.path);
            if (validateNotebookData(data).ok) {
                notebooks.push({ notebookId: entry.path, data });
            }
        } catch {
            // Unreadable notebooks register their connections when they become readable again
        }
    }
    await applyConnectionMigration(registry, planConnectionMigration(notebooks), logger);
}

/// The connection references + notebook a single notebook restored into.
export interface RestoredNotebook {
    /// The notebook id
    notebookId: string;
    /// The connections the notebook registered, connections that were already live are not included
    databases: AttachedDatabaseState[];
    /// The connections the notebook references
    mapping: NotebookAttachedDatabases;
    /// The notebook scripts
    notebookScripts: NotebookScripts;
}

export function mergeRestoredNotebookIntoConnections(
    reg: AttachedDatabaseRegistry,
    restored: RestoredNotebook,
): AttachedDatabaseRegistry {
    for (const database of restored.databases) {
        if (!reg.attachedDatabases.has(database.databaseId)) {
            registerAttachedDatabase(reg, database);
        }
    }
    reg.attachedDatabasesByNotebook.set(restored.notebookId, restored.mapping);
    return { ...reg };
}

export function mergeRestoredNotebookIntoScripts(
    reg: NotebookScriptsRegistry,
    restored: RestoredNotebook,
): NotebookScriptsRegistry {
    reg.notebookScriptsMap.set(restored.notebookId, restored.notebookScripts);
    addNotebookScriptsForConnection(reg, restored.notebookScripts.databaseId, restored.notebookId);
    reg.notebookScriptsByConnectionType[restored.notebookScripts.connectorInfo.connectorType].push(restored.notebookId);
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

export function destroyRestoredNotebook(restored: RestoredNotebook): void {
    destroyNotebookScripts(restored.notebookScripts);
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

/// The live connections that a restored notebook resolves its references against
export type LiveConnections = Pick<AttachedDatabaseRegistry, 'attachedDatabases' | 'attachedDatabasesBySignature'>;

/// Restore a single, already-persisted notebook (connection references + catalog + notebook) and
/// return just that notebook's pieces.
///
/// This is the incremental counterpart to `restoreAppState`, used after a notebook is written to
/// storage at runtime (e.g. imported from a shared URL) so it can be merged into the already-live
/// registries without a full app reload. It reuses the exact same `restoreNotebookEntry` path the boot
/// loader runs, so a URL-imported notebook is decoded and cataloged identically to one
/// loaded at startup. References to live connections reuse them, unknown connections are
/// registered and returned.
export async function restoreSingleNotebook(
    core: DashQL,
    backend: StorageBackend,
    logger: Logger,
    notebookId: string,
    live: LiveConnections,
    processor?: BatchProcessor,
): Promise<RestoredNotebook> {
    // A freshly imported notebook is implicitly OPFS-backed and keyed by its UUID; that's all the
    // manifest entry `restoreNotebookEntry` needs to route the load.
    const notebookEntry: NotebookEntry = { path: notebookId, storageType: StorageBackendType.OPFS };

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
    const attachedDatabasesByNotebook = new Map<string, NotebookAttachedDatabases>();
    const notebookScripts = new Map<string, NotebookScripts>();
    const notebookScriptsByConnection = new Map<string, string[]>();
    const notebookScriptsByConnectionType: string[][] = CONNECTOR_TYPES.map(() => []);

    const noopConsumer = () => { };
    try {
        await restoreNotebookEntry(
            ctx,
            notebookEntry,
            attachedDatabasesByNotebook,
            notebookScripts,
            notebookScriptsByConnection,
            notebookScriptsByConnectionType,
            new ProgressCounter(),
            new ProgressCounter(),
            new ProgressCounter(),
            noopConsumer,
        );
    } catch (error) {
        for (const database of ctx.newConnections.values()) destroyRestoredConnection(database);
        throw error;
    }

    const mapping = attachedDatabasesByNotebook.get(notebookId);
    const scripts = notebookScripts.get(notebookId) ?? null;
    if (mapping == null || !scripts) {
        for (const database of ctx.newConnections.values()) destroyRestoredConnection(database);
        throw new Error(`imported notebook ${notebookId} did not restore its scripts`);
    }
    await flushRestoreWrites(ctx);
    return {
        notebookId,
        databases: [...ctx.newConnections.values()],
        mapping,
        notebookScripts: scripts,
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
    const attachedDatabasesByNotebook = new Map<string, NotebookAttachedDatabases>();
    const notebookScripts = new Map<string, NotebookScripts>();
    const notebookScriptsByConnection = new Map<string, string[]>();
    const invalidNotebooks = new Map<string, InvalidNotebook>();
    const notebookScriptsByConnectionType: string[][] = CONNECTOR_TYPES.map(() => []);

    // Initialize progress counters
    const restoreConnections = new ProgressCounter();
    const restoreCatalogs = new ProgressCounter();
    const restoreNotebookScriptsProgress = new ProgressCounter();

    try {
        // Load manifest
        logger.info("Loading app manifest", {}, LOG_CTX);
        const manifestStartTime = performance.now();
        const notebookEntries = await backend.listNotebooks('dashql-manifest.json');
        let connectionEntries: ConnectionEntry[] = [];
        if (ctx.registry != null) {
            let manifest = await ctx.registry.loadManifest();
            if (manifest.connections === undefined) {
                logger.info("Migrating the connections of notebooks", { notebookCount: notebookEntries.length.toString() }, LOG_CTX);
                await migrateConnections(ctx.registry, notebookEntries, logger);
                manifest = await ctx.registry.loadManifest();
            }
            connectionEntries = manifest.connections ?? [];
        }
        const manifestDuration = performance.now() - manifestStartTime;

        logger.info("Loaded app manifest", {
            notebookCount: notebookEntries.length.toString(),
            connectionCount: connectionEntries.length.toString(),
            durationMs: manifestDuration.toFixed(2)
        }, LOG_CTX);

        // Restore the connections before the notebooks that reference them
        for (const entry of connectionEntries) {
            await restoreConnectionEntry(ctx, entry);
        }

        // Set totals.
        restoreConnections.addTotal(notebookEntries.length);
        restoreCatalogs.addTotal(notebookEntries.length);
        restoreNotebookScriptsProgress.addTotal(notebookEntries.length);

        progressConsumer({
            restoreConnections: restoreConnections.clone(),
            restoreCatalogs: restoreCatalogs.clone(),
            restoreNotebookScripts: restoreNotebookScriptsProgress.clone(),
        });

        // Process each notebook
        logger.info("Restoring notebooks", { count: notebookEntries.length.toString() }, LOG_CTX);
        for (let i = 0; i < notebookEntries.length; i++) {
            const notebookEntry = notebookEntries[i];
            const notebookStartTime = performance.now();

            try {
                logger.info("Restoring notebook", {
                    index: `${i + 1}/${notebookEntries.length}`,
                    notebookId: notebookEntry.path
                }, LOG_CTX);

                await restoreNotebookEntry(
                    ctx,
                    notebookEntry,
                    attachedDatabasesByNotebook,
                    notebookScripts,
                    notebookScriptsByConnection,
                    notebookScriptsByConnectionType,
                    restoreConnections,
                    restoreCatalogs,
                    restoreNotebookScriptsProgress,
                    progressConsumer,
                );

                try {
                    await backend.ensureNotebookIndex?.(notebookEntry.path);
                } catch (error) {
                    // The index is a derived publication sidecar. A failure to backfill it must not
                    // prevent an otherwise valid notebook from loading.
                    logger.warn("Failed to ensure notebook index", {
                        notebookId: notebookEntry.path,
                        error: stringifyError(error),
                    }, LOG_CTX);
                }

                const notebookDuration = performance.now() - notebookStartTime;
                logger.info("Notebook restored", {
                    index: `${i + 1}/${notebookEntries.length}`,
                    notebookId: notebookEntry.path,
                    durationMs: notebookDuration.toFixed(2)
                }, LOG_CTX);
            } catch (error) {
                const notebookDuration = performance.now() - notebookStartTime;

                if (error instanceof InvalidNotebookError) {
                    // Metadata validation refused this notebook up front. Record it so the selector
                    // can show it as invalid (blocked, deletable), and account it as *skipped*
                    // rather than *failed* — nothing was attempted, the metadata was simply
                    // unusable. The notebook contributed no connection/catalog/scripts/scripts.
                    invalidNotebooks.set(error.invalid.notebookId, error.invalid);
                    restoreConnections.addSkipped();
                    restoreCatalogs.addSkipped();
                    restoreNotebookScriptsProgress.addSkipped();

                    progressConsumer({
                        restoreConnections: restoreConnections.clone(),
                        restoreCatalogs: restoreCatalogs.clone(),
                        restoreNotebookScripts: restoreNotebookScriptsProgress.clone(),
                    });
                    continue;
                }

                logger.warn("Failed to restore notebook", {
                    index: `${i + 1}/${notebookEntries.length}`,
                    notebookId: notebookEntry.path,
                    durationMs: notebookDuration.toFixed(2),
                    error: stringifyError(error)
                }, LOG_CTX);

                restoreConnections.addFailed();
                restoreCatalogs.addFailed();
                restoreNotebookScriptsProgress.addFailed();
                progressConsumer({
                    restoreConnections: restoreConnections.clone(),
                    restoreCatalogs: restoreCatalogs.clone(),
                    restoreNotebookScripts: restoreNotebookScriptsProgress.clone(),
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
        restoreNotebookScripts: restoreNotebookScriptsProgress.clone(),
    });

    const totalDuration = performance.now() - startTime;
    logger.info("Finished loading app state", {
        connections: ctx.connectionStates.size.toString(),
        notebookScripts: notebookScripts.size.toString(),
        invalidNotebooks: invalidNotebooks.size.toString(),
        connectionsSucceeded: restoreConnections.succeeded.toString(),
        connectionsFailed: restoreConnections.failed.toString(),
        connectionsSkipped: restoreConnections.skipped.toString(),
        totalDurationMs: totalDuration.toFixed(2)
    }, LOG_CTX);

    return {
        connectionStates: ctx.connectionStates,
        attachedDatabasesByNotebook,
        connectionStatesByType: ctx.connectionStatesByType,
        connectionSignatures: ctx.connectionSignatures,
        notebookScripts,
        notebookScriptsByConnection,
        notebookScriptsByConnectionType,
        invalidNotebooks,
    };
}
