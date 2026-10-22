import * as React from 'react';

import { connectionRefCount, useConnectionRegistry, type ConnectionRegistry } from '../../connections/connection_registry.js';
import { catalogFileMatchesStorage, connectionCatalogMatchesStorage, replaceConnectionCatalogFromStorage } from '../../connections/connection_state.js';
import { useSessionScriptsRegistry } from '../scripts/session_scripts_registry.js';
import { sessionScriptsMatchStorageSnapshot, replaceSessionScriptsFromStorage } from '../scripts/session_scripts.js';
import { isNativePlatform } from '../../../platform/native_globals.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import { stringifyError } from '../../../platform/logger/logger.js';
import { useStorage } from '../../storage/storage_provider.js';
import { getAppFlavor } from '../../flavor/flavor_resolution.js';
import { NativeSessionSyncService, nativeSessionWatchForLocation } from './native_session_sync.js';
import type { SessionScriptsStorageSnapshot, SessionScripts } from '../scripts/session_scripts.js';
import type { ConnectionState } from '../../connections/connection_state.js';
import { DEBOUNCE_DURATION_SESSION_WRITE, groupConnectionFileWrites, WRITE_CONNECTION_FILE, type StorageWriter } from '../../storage/storage_writer.js';
import {
    STORAGE_SCRIPTS_FOLDER,
    STORAGE_CATALOG_FUNCTIONS,
    STORAGE_CATALOG_RELATIONS,
} from '../../storage/storage_backend.js';

const LOG_CTX = 'native_session_sync';

/// The main connection of a session whose catalog the session's files may replace.
/// The catalog files of a session are a copy of its connection's catalog. A connection that several
/// sessions share keeps its catalog, an edited copy in one folder must not replace it for all of them.
function reloadableCatalogConnection(registry: ConnectionRegistry, sessionId: string): ConnectionState | null {
    const connectionId = registry.attachedDatabasesBySession.get(sessionId)?.mainDatabaseId;
    if (connectionId == null || connectionRefCount(registry, connectionId) > 1) return null;
    return registry.connections.get(connectionId) ?? null;
}

interface SessionReloadDecision {
    reload: boolean;
    discardPendingWrites: boolean;
}

async function confirmExternalReload(hasPendingWrites: boolean): Promise<SessionReloadDecision> {
    const appName = getAppFlavor().displayName;
    const message = hasPendingWrites
        ? `This session changed on disk while ${appName} still has local changes waiting to be saved. Reload from disk and discard those pending local changes?`
        : `This session changed outside ${appName}. Reload it from disk?`;
    const reload = await globalThis.dashqlElectron!.confirm({message, title: 'Session changed on disk'});
    return { reload, discardPendingWrites: reload && hasPendingWrites };
}

function isReloadedStorageKey(sessionId: string, key: string): boolean {
    return key === `${sessionId}/${STORAGE_CATALOG_RELATIONS}`
        || key === `${sessionId}/${STORAGE_CATALOG_FUNCTIONS}`
        || key === `${sessionId}/${STORAGE_SCRIPTS_FOLDER}`
        || key.startsWith(`${sessionId}/${STORAGE_SCRIPTS_FOLDER}/`);
}

function snapshotMatchesCompletedWrite(
    sessionId: string,
    snapshot: SessionScriptsStorageSnapshot,
    schema: string | null,
    functions: string | null,
    connection: ConnectionState | undefined,
    sessionScripts: SessionScripts | undefined,
    writer: StorageWriter,
): boolean {
    const diskFiles = new Map<string, string | null>();
    const memoryFiles = new Map<string, string | null>();
    if (connection) {
        diskFiles.set(`${sessionId}/${STORAGE_CATALOG_RELATIONS}`, schema);
        diskFiles.set(`${sessionId}/${STORAGE_CATALOG_FUNCTIONS}`, functions);
        memoryFiles.set(`${sessionId}/${STORAGE_CATALOG_RELATIONS}`, catalogFileMatchesStorage(connection.catalogRelationScript, null)
            ? null
            : connection.catalogRelationScript.toString());
        memoryFiles.set(`${sessionId}/${STORAGE_CATALOG_FUNCTIONS}`, catalogFileMatchesStorage(connection.catalogFunctionScript, null)
            ? null
            : connection.catalogFunctionScript.toString());
    }
    if (sessionScripts) {
        for (const ref of Object.values(sessionScripts.scriptRefs)) {
            const script = sessionScripts.scripts[ref.scriptId];
            if (script) {
                memoryFiles.set(`${sessionId}/${STORAGE_SCRIPTS_FOLDER}/${ref.fileName}`, script.scriptSession.getText());
            }
        }
    }
    for (const script of snapshot.scripts) {
        diskFiles.set(`${sessionId}/${STORAGE_SCRIPTS_FOLDER}/${script.name}`, script.sql);
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
/// coordination, then delegates session reconciliation to the session domain.
export const NativeSessionSync: React.FC = () => {
    const logger = useLogger();
    const [reader, writer] = useStorage();
    const [connectionRegistry, setConnectionRegistry] = useConnectionRegistry();
    const [sessionScriptsRegistry, setSessionScriptsRegistry] = useSessionScriptsRegistry();
    const connectionRegistryRef = React.useRef(connectionRegistry);
    const sessionScriptsRegistryRef = React.useRef(sessionScriptsRegistry);
    connectionRegistryRef.current = connectionRegistry;
    sessionScriptsRegistryRef.current = sessionScriptsRegistry;
    const queuedRef = React.useRef(new Set<string>());
    const processingRef = React.useRef(false);
    const serviceRef = React.useRef<NativeSessionSyncService | null>(null);

    const reloadSession = React.useEffectEvent(async (sessionId: string) => {
        writer.pauseSession(sessionId);
        try {
            // A write that started before the watcher event must finish before the stable disk read.
            await writer.settle();
            // Composite storage mirrors native attachments into the session's OPFS namespace while
            // loading. Do this before the SQL/catalog unchanged fast path so attachment-only edits
            // refresh the files exposed to embedded HyperDB-WASM.
            await reader.backend.loadSession(sessionId);
            const [schema, functions, scripts] = await Promise.all([
                reader.backend.loadSessionSchema(sessionId),
                reader.backend.loadSessionFunctions(sessionId),
                reader.backend.loadScripts(sessionId),
            ]);
            const snapshot: SessionScriptsStorageSnapshot = { scripts };
            const connection = reloadableCatalogConnection(connectionRegistryRef.current, sessionId);
            const currentSessionScripts = sessionScriptsRegistryRef.current.sessionScriptsMap.get(sessionId);
            const sessionUnchanged = currentSessionScripts != null && sessionScriptsMatchStorageSnapshot(currentSessionScripts, snapshot);
            const catalogUnchanged = connection == null || connectionCatalogMatchesStorage(connection, schema, functions);
            if (sessionUnchanged && catalogUnchanged) {
                return;
            }

            // A delayed watcher event for our own completed write can arrive after a newer local edit
            // is already pending. The completed snapshot identifies that event without suppressing a
            // genuinely different external version.
            if (snapshotMatchesCompletedWrite(sessionId, snapshot, schema, functions, connection ?? undefined, currentSessionScripts, writer)) {
                return;
            }

            const isReloadedKey = (key: string) => isReloadedStorageKey(sessionId, key);
            const promptGeneration = writer.getSessionWriteGeneration(sessionId, isReloadedKey);
            const pendingKeys = writer.getPendingKeysForSession(sessionId, isReloadedKey);
            let decision = await confirmExternalReload(pendingKeys.length > 0);
            if (!decision.reload) {
                return;
            }
            // The editor remains interactive while the native dialog is open. If a local edit was
            // queued during a clean-file prompt, require the explicit destructive confirmation too.
            const pendingAfterPrompt = writer.getPendingKeysForSession(sessionId, isReloadedKey);
            if (pendingKeys.length === 0 && pendingAfterPrompt.length > 0) {
                decision = await confirmExternalReload(true);
                if (!decision.reload) {
                    return;
                }
            }
            if (writer.getSessionWriteGeneration(sessionId, isReloadedKey) !== promptGeneration) {
                // The generation changed while the dialog was open. Requeue and take a fresh disk
                // snapshot instead of applying a stale destructive decision.
                queuedRef.current.add(sessionId);
                return;
            }
            if (decision.discardPendingWrites) {
                writer.cancelPendingWritesForSession(sessionId, isReloadedKey);
            }
            await reader.backend.regenerateSessionIndex?.(sessionId);
            const latestConnection = reloadableCatalogConnection(connectionRegistryRef.current, sessionId);
            const latestSessionScripts = sessionScriptsRegistryRef.current.sessionScriptsMap.get(sessionId);
            const catalogChanged = latestConnection != null
                ? replaceConnectionCatalogFromStorage(latestConnection, schema, functions)
                : false;
            if (catalogChanged) {
                setConnectionRegistry(registry => ({ ...registry }));
                // The catalog of the connection follows its only session
                const connectionId = latestConnection!.connectionId;
                for (const [fileName, script] of [
                    [STORAGE_CATALOG_RELATIONS, latestConnection!.catalogRelationScript],
                    [STORAGE_CATALOG_FUNCTIONS, latestConnection!.catalogFunctionScript],
                ] as const) {
                    void writer.write(
                        groupConnectionFileWrites(connectionId, fileName),
                        { type: WRITE_CONNECTION_FILE, value: [connectionId, fileName, script.toString()] },
                        DEBOUNCE_DURATION_SESSION_WRITE,
                    );
                }
            }
            if (latestSessionScripts) {
                const reloadedSessionScripts = replaceSessionScriptsFromStorage(latestSessionScripts, snapshot, logger, catalogChanged);
                setSessionScriptsRegistry(registry => {
                    // Do not overwrite a session that was replaced by another lifecycle operation
                    // while the native confirmation dialog was open.
                    if (registry.sessionScriptsMap.get(sessionId) !== latestSessionScripts) {
                        return registry;
                    }
                    registry.sessionScriptsMap.set(sessionId, reloadedSessionScripts);
                    return { ...registry };
                });
            }
            logger.info('reloaded externally changed session', { sessionId }, LOG_CTX);
        } catch (error) {
            logger.error('failed to reload externally changed session', {
                sessionId,
                error: stringifyError(error),
            }, LOG_CTX);
        } finally {
            writer.resumeSession(sessionId);
        }
    });

    const enqueueReload = React.useEffectEvent((sessionId: string) => {
        queuedRef.current.add(sessionId);
        if (processingRef.current) {
            return;
        }
        processingRef.current = true;
        void (async () => {
            while (queuedRef.current.size > 0) {
                const next = queuedRef.current.values().next().value as string;
                queuedRef.current.delete(next);
                await reloadSession(next);
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
        const service = new NativeSessionSyncService(logger, enqueueReload);
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
        const sessions = [...connectionRegistry.attachedDatabasesBySession.keys()]
            .map(sessionId => nativeSessionWatchForLocation(sessionId, reader.getSessionLocation(sessionId)))
            .filter((watch): watch is NonNullable<typeof watch> => watch != null);
        void serviceRef.current.reconcile(sessions);
    }, [connectionRegistry, reader]);

    return null;
};
