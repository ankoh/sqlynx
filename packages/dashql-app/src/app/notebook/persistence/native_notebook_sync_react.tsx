import * as React from 'react';

import { useAttachedDatabaseRegistry } from '../connections/attached_database_registry.js';
import { catalogFileMatchesStorage, attachedDatabaseCatalogMatchesStorage, replaceAttachedDatabaseCatalogFromStorage } from '../connections/attached_database_state.js';
import { useNotebookScriptsRegistry } from '../scripts/notebook_scripts_registry.js';
import { notebookScriptsMatchStorageSnapshot, replaceNotebookScriptsFromStorage } from '../scripts/notebook_scripts.js';
import { isNativePlatform } from '../../../platform/native_globals.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import { stringifyError } from '../../../platform/logger/logger.js';
import { useStorage } from './storage_provider.js';
import { getAppFlavor } from '../../flavor/flavor_resolution.js';
import { NativeNotebookSyncService, nativeNotebookWatchForLocation } from './native_notebook_sync.js';
import type { NotebookScriptsStorageSnapshot, NotebookScripts } from '../scripts/notebook_scripts.js';
import type { AttachedDatabaseState } from '../connections/attached_database_state.js';
import type { StorageWriter } from './storage_writer.js';
import {
    STORAGE_SCRIPTS_FOLDER,
    STORAGE_SCRIPT_FUNCTIONS,
    STORAGE_SCRIPT_SCHEMA,
} from './storage_backend.js';

const LOG_CTX = 'native_notebook_sync';

interface NotebookReloadDecision {
    reload: boolean;
    discardPendingWrites: boolean;
}

async function confirmExternalReload(hasPendingWrites: boolean): Promise<NotebookReloadDecision> {
    const appName = getAppFlavor().displayName;
    const message = hasPendingWrites
        ? `This notebook changed on disk while ${appName} still has local changes waiting to be saved. Reload from disk and discard those pending local changes?`
        : `This notebook changed outside ${appName}. Reload it from disk?`;
    const reload = await globalThis.dashqlElectron!.confirm({message, title: 'Notebook changed on disk'});
    return { reload, discardPendingWrites: reload && hasPendingWrites };
}

function isReloadedStorageKey(notebookId: string, key: string): boolean {
    return key === `${notebookId}/${STORAGE_SCRIPT_SCHEMA}`
        || key === `${notebookId}/${STORAGE_SCRIPT_FUNCTIONS}`
        || key === `${notebookId}/${STORAGE_SCRIPTS_FOLDER}`
        || key.startsWith(`${notebookId}/${STORAGE_SCRIPTS_FOLDER}/`);
}

function snapshotMatchesCompletedWrite(
    notebookId: string,
    snapshot: NotebookScriptsStorageSnapshot,
    schema: string | null,
    functions: string | null,
    connection: AttachedDatabaseState | undefined,
    notebookScripts: NotebookScripts | undefined,
    writer: StorageWriter,
): boolean {
    const diskFiles = new Map<string, string | null>();
    const memoryFiles = new Map<string, string | null>();
    diskFiles.set(`${notebookId}/${STORAGE_SCRIPT_SCHEMA}`, schema);
    diskFiles.set(`${notebookId}/${STORAGE_SCRIPT_FUNCTIONS}`, functions);
    if (connection) {
        memoryFiles.set(`${notebookId}/${STORAGE_SCRIPT_SCHEMA}`, catalogFileMatchesStorage(connection.catalogRelationScript, null)
            ? null
            : connection.catalogRelationScript.toString());
        memoryFiles.set(`${notebookId}/${STORAGE_SCRIPT_FUNCTIONS}`, catalogFileMatchesStorage(connection.catalogFunctionScript, null)
            ? null
            : connection.catalogFunctionScript.toString());
    }
    if (notebookScripts) {
        for (const ref of Object.values(notebookScripts.scriptRefs)) {
            const script = notebookScripts.scripts[ref.scriptId];
            if (script) {
                memoryFiles.set(`${notebookId}/${STORAGE_SCRIPTS_FOLDER}/${ref.fileName}`, script.scriptSession.getText());
            }
        }
    }
    for (const script of snapshot.scripts) {
        diskFiles.set(`${notebookId}/${STORAGE_SCRIPTS_FOLDER}/${script.name}`, script.sql);
    }
    let divergenceFound = false;
    for (const path of new Set([...diskFiles.keys(), ...memoryFiles.keys()])) {
        const disk = diskFiles.get(path) ?? null;
        const memory = memoryFiles.get(path) ?? null;
        if (disk === memory) {
            continue;
        }
        divergenceFound = true;
        if (writer.getCompletedFileContent(path) !== disk) {
            return false;
        }
    }
    return divergenceFound;
}

/// Native-only synchronization boundary. It owns watcher setup, conflict prompting and storage
/// coordination, then delegates notebook reconciliation to the notebook domain.
export const NativeNotebookSync: React.FC = () => {
    const logger = useLogger();
    const [reader, writer] = useStorage();
    const [connectionRegistry, setAttachedDatabaseRegistry] = useAttachedDatabaseRegistry();
    const [notebookScriptsRegistry, setNotebookScriptsRegistry] = useNotebookScriptsRegistry();
    const connectionRegistryRef = React.useRef(connectionRegistry);
    const notebookScriptsRegistryRef = React.useRef(notebookScriptsRegistry);
    connectionRegistryRef.current = connectionRegistry;
    notebookScriptsRegistryRef.current = notebookScriptsRegistry;
    const queuedRef = React.useRef(new Set<string>());
    const processingRef = React.useRef(false);
    const serviceRef = React.useRef<NativeNotebookSyncService | null>(null);

    const reloadNotebook = React.useEffectEvent(async (notebookId: string) => {
        writer.pauseNotebook(notebookId);
        try {
            // A write that started before the watcher event must finish before the stable disk read.
            await writer.settle();
            // Composite storage mirrors native attachments into the notebook's OPFS namespace while
            // loading. Do this before the SQL/catalog unchanged fast path so attachment-only edits
            // refresh the files exposed to embedded HyperDB-WASM.
            await reader.backend.loadNotebook(notebookId);
            const [schema, functions, scripts] = await Promise.all([
                reader.backend.loadNotebookSchema(notebookId),
                reader.backend.loadNotebookFunctions(notebookId),
                reader.backend.loadScripts(notebookId),
            ]);
            const snapshot: NotebookScriptsStorageSnapshot = { scripts };
            const mapping = connectionRegistryRef.current.attachedDatabasesByNotebook.get(notebookId);
            const connectionId = mapping?.mainDatabaseId;
            const connection = connectionId == null ? null : connectionRegistryRef.current.attachedDatabases.get(connectionId);
            const currentNotebookScripts = notebookScriptsRegistryRef.current.notebookScriptsMap.get(notebookId);
            const notebookUnchanged = currentNotebookScripts != null && notebookScriptsMatchStorageSnapshot(currentNotebookScripts, snapshot);
            const catalogUnchanged = connection != null && attachedDatabaseCatalogMatchesStorage(connection, schema, functions);
            if (notebookUnchanged && catalogUnchanged) {
                return;
            }

            // A delayed watcher event for our own completed write can arrive after a newer local edit
            // is already pending. The completed snapshot identifies that event without suppressing a
            // genuinely different external version.
            if (snapshotMatchesCompletedWrite(notebookId, snapshot, schema, functions, connection ?? undefined, currentNotebookScripts, writer)) {
                return;
            }

            const isReloadedKey = (key: string) => isReloadedStorageKey(notebookId, key);
            const promptGeneration = writer.getNotebookWriteGeneration(notebookId, isReloadedKey);
            const pendingKeys = writer.getPendingKeysForNotebook(notebookId, isReloadedKey);
            let decision = await confirmExternalReload(pendingKeys.length > 0);
            if (!decision.reload) {
                return;
            }
            // The editor remains interactive while the native dialog is open. If a local edit was
            // queued during a clean-file prompt, require the explicit destructive confirmation too.
            const pendingAfterPrompt = writer.getPendingKeysForNotebook(notebookId, isReloadedKey);
            if (pendingKeys.length === 0 && pendingAfterPrompt.length > 0) {
                decision = await confirmExternalReload(true);
                if (!decision.reload) {
                    return;
                }
            }
            if (writer.getNotebookWriteGeneration(notebookId, isReloadedKey) !== promptGeneration) {
                // The generation changed while the dialog was open. Requeue and take a fresh disk
                // snapshot instead of applying a stale destructive decision.
                queuedRef.current.add(notebookId);
                return;
            }
            if (decision.discardPendingWrites) {
                writer.cancelPendingWritesForNotebook(notebookId, isReloadedKey);
            }
            await reader.backend.regenerateNotebookIndex?.(notebookId);
            const latestMapping = connectionRegistryRef.current.attachedDatabasesByNotebook.get(notebookId);
            const latestConnectionId = latestMapping?.mainDatabaseId;
            const latestConnection = latestConnectionId == null ? null : connectionRegistryRef.current.attachedDatabases.get(latestConnectionId);
            const latestNotebookScripts = notebookScriptsRegistryRef.current.notebookScriptsMap.get(notebookId);
            const catalogChanged = latestConnection != null
                ? replaceAttachedDatabaseCatalogFromStorage(latestConnection, schema, functions)
                : false;
            if (catalogChanged) {
                setAttachedDatabaseRegistry(registry => ({ ...registry }));
            }
            if (latestNotebookScripts) {
                const reloadedNotebookScripts = replaceNotebookScriptsFromStorage(latestNotebookScripts, snapshot, logger, catalogChanged);
                setNotebookScriptsRegistry(registry => {
                    // Do not overwrite a notebook that was replaced by another lifecycle operation
                    // while the native confirmation dialog was open.
                    if (registry.notebookScriptsMap.get(notebookId) !== latestNotebookScripts) {
                        return registry;
                    }
                    registry.notebookScriptsMap.set(notebookId, reloadedNotebookScripts);
                    return { ...registry };
                });
            }
            logger.info('reloaded externally changed notebook', { notebookId }, LOG_CTX);
        } catch (error) {
            logger.error('failed to reload externally changed notebook', {
                notebookId,
                error: stringifyError(error),
            }, LOG_CTX);
        } finally {
            writer.resumeNotebook(notebookId);
        }
    });

    const enqueueReload = React.useEffectEvent((notebookId: string) => {
        queuedRef.current.add(notebookId);
        if (processingRef.current) {
            return;
        }
        processingRef.current = true;
        void (async () => {
            while (queuedRef.current.size > 0) {
                const next = queuedRef.current.values().next().value as string;
                queuedRef.current.delete(next);
                await reloadNotebook(next);
            }
            processingRef.current = false;
        })();
    });

    React.useEffect(() => {
        if (!isNativePlatform()) {
            return;
        }
        // enqueueReload is an effect event and must not be a dependency.
        // It changes with every render and would tear down all directory watches on every registry update.
        const service = new NativeNotebookSyncService(logger, enqueueReload);
        serviceRef.current = service;
        return () => {
            service.close();
            if (serviceRef.current === service) {
                serviceRef.current = null;
            }
        };
    }, [logger]);

    React.useEffect(() => {
        if (!isNativePlatform() || !serviceRef.current) {
            return;
        }
        const notebooks = [...connectionRegistry.attachedDatabasesByNotebook.keys()]
            .map(notebookId => nativeNotebookWatchForLocation(notebookId, reader.getNotebookLocation(notebookId)))
            .filter((watch): watch is NonNullable<typeof watch> => watch != null);
        void serviceRef.current.reconcile(notebooks);
    }, [connectionRegistry, reader]);

    return null;
};
