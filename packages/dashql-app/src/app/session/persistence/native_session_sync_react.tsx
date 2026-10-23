import * as React from 'react';

import { connectionEntryFromState, registerConnection, resolveDefaultConnection, useConnectionReferences, useConnectionRegistry, type ConnectionReferences, type ConnectionRegistry } from '../../connections/connection_registry.js';
import { reindexSessionScriptConnections, useSessionScriptsRegistry } from '../scripts/session_scripts_registry.js';
import { sessionScriptsMatchStorageSnapshot, replaceSessionScriptsFromStorage, scriptConnectionOf } from '../scripts/session_scripts.js';
import { isDesktopHost } from '../../../platform/native_globals.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import { stringifyError } from '../../../platform/logger/logger.js';
import { useStorage } from '../../storage/storage_provider.js';
import { getAppFlavor } from '../../flavor/flavor_resolution.js';
import { NativeSessionSyncService, nativeSessionWatchForLocation } from './native_session_sync.js';
import type { SessionScriptsStorageSnapshot, SessionScripts } from '../scripts/session_scripts.js';
import { persistedConnectionId, sessionScriptList } from '../scripts/session_scripts.js';
import { connectionStateFromStorage, destroyUnregisteredConnection } from '../../connections/connection_restore.js';
import { resolveSessionScripts, sessionScriptsResolutionChanged } from './session_script_connections.js';
import type { ConnectionState } from '../../connections/connection_state.js';
import {
    DEBOUNCE_DURATION_SESSION_WRITE,
    groupConnectionEntryWrites,
    groupSessionAttachmentListWrites,
    groupSessionScriptListWrites,
    REFRESH_SESSION_ATTACHMENTS,
    WRITE_CONNECTION_ENTRY,
    WRITE_SESSION_SCRIPTS,
    type StorageWriter,
} from '../../storage/storage_writer.js';
import {
    STORAGE_SCRIPTS_FOLDER,
    STORAGE_SESSION_FILE,
    type ScriptData,
    type SessionData,
    type SessionScript,
} from '../../storage/storage_backend.js';
import { sessionScriptsEqual } from '../../storage/session_files.js';

const LOG_CTX = 'native_session_sync';

/// The scripts of a session as its folder holds them, resolved like the restoration of the app does.
/// A connection that the app doesn't know is created from the copy of the session file, e.g. after
/// pulling a script on a new connection. It is registered when the reload is applied and must be
/// destroyed otherwise.
export interface StoredSessionScripts {
    /// The scripts as the session scripts take them
    snapshot: SessionScriptsStorageSnapshot;
    /// The session file that describes the resolved scripts
    session: SessionData;
    /// The connections that were created from copies of the session file
    created: ConnectionState[];
}

export function readStoredSessionScripts(
    registry: ConnectionRegistry,
    references: ConnectionReferences,
    sessionId: string,
    session: SessionData,
    scripts: ScriptData[],
): StoredSessionScripts | null {
    const main = resolveDefaultConnection(registry, references, sessionId);
    if (main == null) return null;
    const created: ConnectionState[] = [];
    const resolved = resolveSessionScripts(session, scripts.map(script => script.name), main, (connectionId, copy) => {
        const known = registry.connections.get(connectionId);
        if (known != null || copy == null) return known ?? null;
        const connection = connectionStateFromStorage(main.instance, connectionId, copy);
        created.push(connection);
        return connection;
    });
    const sqlByName = new Map(scripts.map(script => [script.name, script.sql]));
    return {
        snapshot: {
            scripts: resolved.scripts.map(entry => ({
                name: entry.name,
                sql: sqlByName.get(entry.name) ?? '',
                connection: scriptConnectionOf(entry.connection),
                ...(entry.unresolvedConnectionId == null ? {} : { unresolvedConnectionId: entry.unresolvedConnectionId }),
            })),
        },
        session: resolved.session,
        created,
    };
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
    return key === groupSessionScriptListWrites(sessionId)
        || key === `${sessionId}/${STORAGE_SCRIPTS_FOLDER}`
        || key.startsWith(`${sessionId}/${STORAGE_SCRIPTS_FOLDER}/`);
}

function snapshotMatchesCompletedWrite(
    sessionId: string,
    snapshot: SessionScriptsStorageSnapshot,
    sessionScripts: SessionScripts | undefined,
    writer: StorageWriter,
): boolean {
    const diskFiles = new Map<string, string | null>();
    const memoryFiles = new Map<string, string | null>();
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
    // The order and the connections of the scripts are part of the session file
    const diskList = snapshot.scripts.map(script => ({ name: script.name, connectionId: persistedConnectionId(script) }));
    if (sessionScripts && !sessionScriptsEqual(sessionScriptList(sessionScripts), diskList)) {
        divergenceFound = true;
        const completed = writer.getCompletedFileContent(`${sessionId}/${STORAGE_SESSION_FILE}`);
        let completedList: SessionScript[] | null = null;
        try {
            completedList = completed == null ? null : (JSON.parse(completed) as SessionData).scripts ?? null;
        } catch {
            completedList = null;
        }
        if (completedList == null || !sessionScriptsEqual(completedList, diskList)) {
            return false;
        }
    }
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
    const references = useConnectionReferences();
    const connectionRegistryRef = React.useRef(connectionRegistry);
    const sessionScriptsRegistryRef = React.useRef(sessionScriptsRegistry);
    connectionRegistryRef.current = connectionRegistry;
    sessionScriptsRegistryRef.current = sessionScriptsRegistry;
    const queuedRef = React.useRef(new Set<string>());
    const processingRef = React.useRef(false);
    const serviceRef = React.useRef<NativeSessionSyncService | null>(null);

    const reloadSession = React.useEffectEvent(async (sessionId: string) => {
        writer.pauseSession(sessionId);
        let stored: StoredSessionScripts | null = null;
        let registered = false;
        try {
            // A write that started before the watcher event must finish before the stable disk read.
            await writer.settle();
            // Composite storage mirrors native attachments into the session's OPFS namespace while
            // loading. Do this before the SQL unchanged fast path so attachment-only edits
            // refresh the files exposed to embedded HyperDB-WASM.
            const sessionFile = await reader.backend.loadSession(sessionId);
            // The session file lists the attachments, the write runs once the session resumes
            void writer.write(groupSessionAttachmentListWrites(sessionId), { type: REFRESH_SESSION_ATTACHMENTS, value: sessionId });
            const scripts = await reader.backend.loadScripts(sessionId);
            stored = readStoredSessionScripts(connectionRegistryRef.current, references, sessionId, sessionFile, scripts);
            if (stored == null) {
                return;
            }
            const snapshot = stored.snapshot;
            const currentSessionScripts = sessionScriptsRegistryRef.current.sessionScriptsMap.get(sessionId);
            if (currentSessionScripts != null && sessionScriptsMatchStorageSnapshot(currentSessionScripts, snapshot)) {
                return;
            }

            // A delayed watcher event for our own completed write can arrive after a newer local edit
            // is already pending. The completed snapshot identifies that event without suppressing a
            // genuinely different external version.
            if (snapshotMatchesCompletedWrite(sessionId, snapshot, currentSessionScripts, writer)) {
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
            // Connections that the session file brought along join the app before the scripts use them
            const created = stored.created;
            if (created.length > 0) {
                setConnectionRegistry(registry => {
                    for (const connection of created) registerConnection(registry, connection);
                    return { ...registry };
                });
                for (const connection of created) {
                    void writer.write(
                        groupConnectionEntryWrites(connection.connectionId),
                        { type: WRITE_CONNECTION_ENTRY, value: { ...connectionEntryFromState(connection), createdAt: new Date().toISOString() } },
                    );
                }
            }
            registered = true;
            // Files that were added or removed outside the app change the script list
            if (sessionScriptsResolutionChanged(sessionFile, stored.session)) {
                const { scripts, connections } = stored.session;
                void writer.write(
                    groupSessionScriptListWrites(sessionId),
                    { type: WRITE_SESSION_SCRIPTS, value: [sessionId, { scripts, connections }] },
                    DEBOUNCE_DURATION_SESSION_WRITE,
                );
            }
            const latestSessionScripts = sessionScriptsRegistryRef.current.sessionScriptsMap.get(sessionId);
            if (latestSessionScripts) {
                const reloadedSessionScripts = replaceSessionScriptsFromStorage(latestSessionScripts, snapshot, logger);
                setSessionScriptsRegistry(registry => {
                    // Do not overwrite a session that was replaced by another lifecycle operation
                    // while the native confirmation dialog was open.
                    if (registry.sessionScriptsMap.get(sessionId) !== latestSessionScripts) {
                        return registry;
                    }
                    registry.sessionScriptsMap.set(sessionId, reloadedSessionScripts);
                    reindexSessionScriptConnections(registry, latestSessionScripts, reloadedSessionScripts);
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
            if (!registered) {
                for (const connection of stored?.created ?? []) destroyUnregisteredConnection(connection);
            }
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
        if (!isDesktopHost()) {
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
        if (!isDesktopHost() || !serviceRef.current) {
            return;
        }
        const sessions = [...sessionScriptsRegistry.sessionScriptsMap.keys()]
            .map(sessionId => nativeSessionWatchForLocation(sessionId, reader.getSessionLocation(sessionId)))
            .filter((watch): watch is NonNullable<typeof watch> => watch != null);
        void serviceRef.current.reconcile(sessions);
    }, [sessionScriptsRegistry, reader]);

    return null;
};
