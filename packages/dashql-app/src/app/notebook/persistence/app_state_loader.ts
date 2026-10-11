import type { DashQL } from '@ankoh/dashql-core';
import type { Logger } from '../../../platform/logger/logger.js';
import { stringifyError } from '../../../platform/logger/logger.js';
import { ProgressCounter } from '../../../utils/progress.js';
import type { AttachedDatabaseState } from '../connections/attached_database_state.js';
import type { AttachedDatabaseRegistry, NotebookAttachedDatabases } from '../connections/attached_database_registry.js';
import type { NotebookScripts, ScriptData } from '../scripts/notebook_scripts.js';
import type { NotebookScriptsRegistry } from '../scripts/notebook_scripts_registry.js';
import { createEmptyScriptData, destroyNotebookScripts, replaceScriptSessionText } from '../scripts/notebook_scripts.js';
import { decodeConnectionFromProto, restoreAttachedDatabaseState } from '../connections/connection_import.js';
import { CONNECTOR_TYPES, ConnectorType, type ConnectorInfo } from '../connections/connector_info.js';
import type { StorageBackend, NotebookEntry, NotebookData } from './storage_backend.js';
import { StorageBackendType } from './storage_backend.js';
import { validateNotebookData, describeInvalidNotebook, isValidUuid, NotebookValidationError, type InvalidNotebook } from './notebook_validation.js';
import { CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK } from '../connections/catalog_update_state.js';
import { beginCatalogBatch, invalidateCatalogBatch, publishCatalogBatch, type BatchProcessor, type CatalogBatchEntry } from '../connections/catalog_batch.js';

const LOG_CTX = "app_state_loader";

export interface RestoredAppState {
    connectionStates: Map<string, AttachedDatabaseState>;
    attachedDatabasesByNotebook: Map<string, NotebookAttachedDatabases>;
    connectionStatesByType: string[][];
    connectionSignatures: Map<string, string | null>;
    notebookScripts: Map<string, NotebookScripts>;
    notebookScriptsByConnection: Map<string, string>;
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

/// Restores a single notebook (connection + catalog + notebook)
async function restoreNotebookEntry(
    core: DashQL,
    backend: StorageBackend,
    logger: Logger,
    notebookEntry: NotebookEntry,
    connectionStates: Map<string, AttachedDatabaseState>,
    attachedDatabasesByNotebook: Map<string, NotebookAttachedDatabases>,
    connectionSignatures: Map<string, string | null>,
    connectionStatesByType: string[][],
    notebookScripts: Map<string, NotebookScripts>,
    notebookScriptsByConnection: Map<string, string>,
    notebookScriptsByConnectionType: string[][],
    restoreConnections: ProgressCounter,
    restoreCatalogs: ProgressCounter,
    restoreNotebookScriptsProgress: ProgressCounter,
    progressConsumer: (progress: AppStateRestorationProgress) => void,
    processor?: BatchProcessor,
): Promise<void> {
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

    // Phase 1: Restore connection
    logger.info("Restoring connection", { notebookId }, LOG_CTX);
    const connectionStartTime = performance.now();
    restoreConnections.addStarted();
    progressConsumer({
        restoreConnections: restoreConnections.clone(),
        restoreCatalogs: restoreCatalogs.clone(),
        restoreNotebookScripts: restoreNotebookScriptsProgress.clone(),
    });

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

    // Decode connection details (validation above guarantees the params map to a known connector)
    const restoreDatabase = (database: NotebookData['attachedDatabases'][number]) => {
        const [connectorInfo, details] = decodeConnectionFromProto(database.params as any, notebookId);
        const state = restoreAttachedDatabaseState(core, database.databaseId, connectorInfo, details, connectionSignatures);
        connectionStates.set(state.databaseId, state);
        connectionStatesByType[connectorInfo.connectorType].push(state.databaseId);
        return state;
    };
    const connectionState = restoreDatabase(notebookData.mainDatabase);
    const attachedConnectionStates = notebookData.attachedDatabases.map(restoreDatabase);
    const connectorInfo = connectionState.connectorInfo;
    attachedDatabasesByNotebook.set(notebookId, {
        mainDatabaseId: connectionState.databaseId,
        attachedDatabaseIds: attachedConnectionStates.map(database => database.databaseId),
    });

    const connectionDuration = performance.now() - connectionStartTime;
    logger.info("Connection restored", {
        notebookId,
        connectorType: ConnectorType[connectorInfo.connectorType],
        durationMs: connectionDuration.toFixed(2)
    }, LOG_CTX);

    restoreConnections.addSucceeded();

    // Phase 2: Restore the main database catalog. Other attached databases retain their own catalogs;
    // notebook scripts and persisted catalog SQL always route to the explicit main database.
    logger.info("Restoring catalog", { notebookId }, LOG_CTX);
    const catalogStartTime = performance.now();
    restoreCatalogs.addStarted();
    progressConsumer({
        restoreConnections: restoreConnections.clone(),
        restoreCatalogs: restoreCatalogs.clone(),
        restoreNotebookScripts: restoreNotebookScriptsProgress.clone(),
    });

    try {
        const validate = beginCatalogBatch(connectionState.catalog);
        logger.info("Loading catalog scripts", { notebookId }, LOG_CTX);
        const [schemaSQL, functionsSQL] = await Promise.all([
            backend.loadNotebookSchema(notebookId),
            backend.loadNotebookFunctions(notebookId),
        ]);
        validate();
        const { catalog, catalogRelationScript, catalogFunctionScript } = connectionState;
        const catalogScripts: CatalogBatchEntry[] = [];

        if (schemaSQL && schemaSQL.trim().length > 0) {
            logger.info("Catalog schema loaded", {
                notebookId,
                schemaLength: schemaSQL.length.toString()
            }, LOG_CTX);
            catalogScripts.push({ script: catalogRelationScript, text: schemaSQL, rank: CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK });
        } else {
            logger.info("No catalog schema found for notebook", { notebookId }, LOG_CTX);
        }

        if (functionsSQL && functionsSQL.trim().length > 0) {
            logger.info("Catalog functions loaded", {
                notebookId,
                functionsLength: functionsSQL.length.toString()
            }, LOG_CTX);
            catalogScripts.push({ script: catalogFunctionScript, text: functionsSQL, rank: CATALOG_DEFAULT_DESCRIPTOR_POOL_RANK });
        }

        if (catalogScripts.length > 0) {
            await publishCatalogBatch(core, catalog, catalogScripts, { processor }, validate);
            connectionState.catalogUpdates.restoredAt = new Date();

            const catalogDuration = performance.now() - catalogStartTime;
            logger.info("Catalog scripts restored", {
                notebookId,
                durationMs: catalogDuration.toFixed(2)
            }, LOG_CTX);
        }

        restoreCatalogs.addSucceeded();
    } catch (catalogError) {
        const catalogDuration = performance.now() - catalogStartTime;

        logger.warn("Failed to restore catalog, will refresh on connect", {
            notebookId,
            durationMs: catalogDuration.toFixed(2),
            error: stringifyError(catalogError)
        }, LOG_CTX);

        // Catalog restoration is non-critical - connection is still usable
        restoreCatalogs.addFailed();
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
            core,
            backend,
            notebookId,
            connectionState.databaseId,
            notebookData.name?.trim() || null,
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
        notebookScriptsByConnection.set(connectionState.databaseId, notebookId);
        notebookScriptsByConnectionType[connectorInfo.connectorType].push(notebookId);
    }

    progressConsumer({
        restoreConnections: restoreConnections.clone(),
        restoreCatalogs: restoreCatalogs.clone(),
        restoreNotebookScripts: restoreNotebookScriptsProgress.clone(),
    });
}

/// The connection + notebook a single notebook restored into.
export interface RestoredNotebook {
    notebookId: string;
    databases: AttachedDatabaseState[];
    mapping: NotebookAttachedDatabases;
    notebookScripts: NotebookScripts;
}

export function mergeRestoredNotebookIntoConnections(
    reg: AttachedDatabaseRegistry,
    restored: RestoredNotebook,
): AttachedDatabaseRegistry {
    for (const database of restored.databases) {
        reg.attachedDatabases.set(database.databaseId, database);
        reg.attachedDatabasesByType[database.connectorInfo.connectorType].push(database.databaseId);
        reg.attachedDatabasesBySignature.set(database.connectionSignature.signatureString, database.databaseId);
    }
    reg.attachedDatabasesByNotebook.set(restored.notebookId, restored.mapping);
    return { ...reg };
}

export function mergeRestoredNotebookIntoScripts(
    reg: NotebookScriptsRegistry,
    restored: RestoredNotebook,
): NotebookScriptsRegistry {
    reg.notebookScriptsMap.set(restored.notebookId, restored.notebookScripts);
    reg.notebookScriptsByConnection.set(restored.notebookScripts.databaseId, restored.notebookId);
    reg.notebookScriptsByConnectionType[restored.notebookScripts.connectorInfo.connectorType].push(restored.notebookId);
    return { ...reg };
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

/// Restore a single, already-persisted notebook (connection + catalog + notebook) into fresh scratch
/// maps and return just that notebook's pieces.
///
/// This is the incremental counterpart to `restoreAppState`, used after a notebook is written to
/// storage at runtime (e.g. imported from a shared URL) so it can be merged into the already-live
/// registries without a full app reload. It reuses the exact same `restoreNotebookEntry` path the boot
/// loader runs, so a URL-imported notebook is decoded and cataloged identically to one
/// loaded at startup.
export async function restoreSingleNotebook(
    core: DashQL,
    backend: StorageBackend,
    logger: Logger,
    notebookId: string,
    connectionSignatures: Map<string, string | null>,
    processor?: BatchProcessor,
): Promise<RestoredNotebook> {
    // A freshly imported notebook is implicitly OPFS-backed and keyed by its UUID; that's all the
    // manifest entry `restoreNotebookEntry` needs to route the load.
    const notebookEntry: NotebookEntry = { path: notebookId, storageType: StorageBackendType.OPFS };

    const connectionStates = new Map<string, AttachedDatabaseState>();
    const attachedDatabasesByNotebook = new Map<string, NotebookAttachedDatabases>();
    const notebookScripts = new Map<string, NotebookScripts>();
    const notebookScriptsByConnection = new Map<string, string>();
    const connectionStatesByType: string[][] = CONNECTOR_TYPES.map(() => []);
    const notebookScriptsByConnectionType: string[][] = CONNECTOR_TYPES.map(() => []);

    const noopConsumer = () => { };
    await restoreNotebookEntry(
        core,
        backend,
        logger,
        notebookEntry,
        connectionStates,
        attachedDatabasesByNotebook,
        connectionSignatures,
        connectionStatesByType,
        notebookScripts,
        notebookScriptsByConnection,
        notebookScriptsByConnectionType,
        new ProgressCounter(),
        new ProgressCounter(),
        new ProgressCounter(),
        noopConsumer,
        processor,
    );

    const mapping = attachedDatabasesByNotebook.get(notebookId);
    const connection = mapping == null ? null : connectionStates.get(mapping.mainDatabaseId);
    if (!connection || mapping == null) {
        // restoreNotebookEntry only fails to register a connection by throwing (invalid/unreadable), which
        // would have propagated above. Reaching here means the persisted id didn't match — treat it
        // as a hard restore failure rather than silently returning a half-loaded notebook.
        throw new Error(`imported notebook ${notebookId} did not restore a connection`);
    }
    const scripts = notebookScripts.get(notebookId) ?? null;
    if (!scripts) {
        for (const database of connectionStates.values()) destroyRestoredConnection(database);
        throw new Error(`imported notebook ${notebookId} did not restore its scripts`);
    }
    return {
        notebookId,
        databases: [...connectionStates.values()],
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

    const connectionStates = new Map<string, AttachedDatabaseState>();
    const attachedDatabasesByNotebook = new Map<string, NotebookAttachedDatabases>();
    const connectionSignatures = new Map<string, string | null>();
    const notebookScripts = new Map<string, NotebookScripts>();
    const notebookScriptsByConnection = new Map<string, string>();
    const invalidNotebooks = new Map<string, InvalidNotebook>();

    const connectionStatesByType: string[][] = CONNECTOR_TYPES.map(() => []);
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
        const manifestDuration = performance.now() - manifestStartTime;

        logger.info("Loaded app manifest", {
            notebookCount: notebookEntries.length.toString(),
            durationMs: manifestDuration.toFixed(2)
        }, LOG_CTX);

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
                    core,
                    backend,
                    logger,
                    notebookEntry,
                    connectionStates,
                    attachedDatabasesByNotebook,
                    connectionSignatures,
                    connectionStatesByType,
                    notebookScripts,
                    notebookScriptsByConnection,
                    notebookScriptsByConnectionType,
                    restoreConnections,
                    restoreCatalogs,
                    restoreNotebookScriptsProgress,
                    progressConsumer,
                    processor,
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

    progressConsumer({
        restoreConnections: restoreConnections.clone(),
        restoreCatalogs: restoreCatalogs.clone(),
        restoreNotebookScripts: restoreNotebookScriptsProgress.clone(),
    });

    const totalDuration = performance.now() - startTime;
    logger.info("Finished loading app state", {
        connections: connectionStates.size.toString(),
        notebookScripts: notebookScripts.size.toString(),
        invalidNotebooks: invalidNotebooks.size.toString(),
        connectionsSucceeded: restoreConnections.succeeded.toString(),
        connectionsFailed: restoreConnections.failed.toString(),
        connectionsSkipped: restoreConnections.skipped.toString(),
        totalDurationMs: totalDuration.toFixed(2)
    }, LOG_CTX);

    return {
        connectionStates,
        attachedDatabasesByNotebook,
        connectionStatesByType,
        connectionSignatures,
        notebookScripts,
        notebookScriptsByConnection,
        notebookScriptsByConnectionType,
        invalidNotebooks,
    };
}
