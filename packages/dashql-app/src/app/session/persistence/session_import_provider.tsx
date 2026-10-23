import * as React from 'react';

import { filterInvalidSessionCatalogs, type SessionBundle } from '../../storage/session_bundle.js';
import type { PreparedNativeSession } from '../../storage/composite_storage_backend.js';
import { CompositeStorageBackend } from '../../storage/composite_storage_backend.js';
import {
    findSessionImportConflict,
    type SessionImportConflict,
    prepareNativeSessionImport,
    registerNativeSession,
    replaceSessionWithNativeFolder,
    replaceSessionWithPortableBundle,
    writePortableSessionFresh,
} from '../../storage/session_import_transaction.js';
import { displayPath } from '../../storage/session_locator.js';
import { useStorage } from '../../storage/storage_provider.js';
import { restoreSingleSession } from './app_state_loader.js';
import { mergeRestoredSessionIntoConnections, mergeRestoredSessionIntoScripts } from './app_state_loader.js';
import { connectionEntryFromState, findSessionQueries, useConnectionReferences, useConnectionRegistrySetter, useConnectionRegistryStore } from '../../connections/connection_registry.js';
import type { ConnectionState } from '../../connections/connection_state.js';
import { useSessionScriptsRegistrySetter } from '../scripts/session_scripts_registry.js';
import { useDashQLCoreSetup } from '../../providers/core_provider.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import { useCancelQuery } from '../../connections/query_executor.js';
import { SessionImportConflictDialog } from '../ui/session_import_conflict_dialog.js';
import { SessionConnectionImportDialog } from '../ui/session_connection_import_dialog.js';
import { StorageBackendType, type ConnectionEntry } from '../../storage/storage_backend.js';
import {
    applyConnectionImportPlan,
    connectionImportQuestions,
    connectionRefsChanged,
    planConnectionImport,
    type ConnectionImportChoice,
    type ConnectionImportPlanItem,
} from './session_connection_import.js';
import { AppHost, getAppHost } from '../../../platform/native_globals.js';

type ImportPresentation =
    | { mode: 'centered' }
    | {
        mode: 'anchored';
        anchorRef: React.RefObject<Element | null>;
        returnFocusRef: React.RefObject<HTMLElement | null>;
    };

export interface PortableSessionImportOptions {
    presentation: ImportPresentation;
    reloadAfterSuccess?: boolean;
}

interface SessionImportContextValue {
    findPortableBundleConflict(bundle: SessionBundle): Promise<{ displayLocation: string; isNative: boolean } | null>;
    importPortableBundleWithChoice(bundle: SessionBundle, choice: ConflictChoice): Promise<string | null>;
    importPortableBundle(bundle: SessionBundle, options: PortableSessionImportOptions): Promise<string | null>;
    importNativeFolder(dir: string, presentation: ImportPresentation): Promise<string | null>;
}

type ConflictChoice = 'replace' | 'create-new';

interface ConflictDialogState {
    bundle: SessionBundle;
    existingDisplayLocation: string;
    presentation: ImportPresentation;
    busy: boolean;
    run(choice: ConflictChoice): Promise<string>;
    resolve(value: string | null): void;
}

/// The question whether imported connections should use existing connections
interface ConnectionDialogState {
    /// The name of the imported session
    sessionName: string;
    /// The connections that may consolidate
    questions: ConnectionImportPlanItem[];
    /// Resolve with the choices, null if the import was cancelled
    resolve(choices: Map<string, ConnectionImportChoice> | null): void;
}

const SESSION_IMPORT_CTX = React.createContext<SessionImportContextValue | null>(null);

export function useSessionImport(): SessionImportContextValue {
    const value = React.useContext(SESSION_IMPORT_CTX);
    if (value == null) throw new Error('useSessionImport must be used within SessionImportProvider');
    return value;
}

export function SessionImportProvider(props: React.PropsWithChildren) {
    const logger = useLogger();
    const setupCore = useDashQLCoreSetup();
    const [reader, writer] = useStorage();
    // Read the registry when importing instead of re-creating the import context for every query event
    const connectionStore = useConnectionRegistryStore();
    const references = useConnectionReferences();
    const setConnections = useConnectionRegistrySetter();
    const setScripts = useSessionScriptsRegistrySetter();
    const cancelQuery = useCancelQuery();
    const [dialog, setDialog] = React.useState<ConflictDialogState | null>(null);
    const [connectionDialog, setConnectionDialog] = React.useState<ConnectionDialogState | null>(null);

    const backend = reader.backend instanceof CompositeStorageBackend ? reader.backend : null;

    const validatePortableBundle = React.useCallback(async (bundle: SessionBundle): Promise<SessionBundle> => {
        const core = await setupCore('session_import_validation');
        const validation = filterInvalidSessionCatalogs(core, bundle);
        if (validation.invalidFiles.length > 0) {
            logger.warn('ignored malformed session catalog files', {
                sessionId: bundle.session.sessionId,
                files: validation.invalidFiles.join(', '),
            }, 'session_import');
        }
        return validation.bundle;
    }, [logger, setupCore]);

    /// Map the connections of an imported session to the connections of the app.
    /// Connections that may consolidate with existing ones are decided by the user, null if the
    /// user cancelled the import.
    const resolveConnections = React.useCallback(async (bundle: SessionBundle): Promise<SessionBundle | null> => {
        if (backend == null) return bundle;
        // The live connections may be ahead of the manifest while writes are debounced
        const live = connectionStore.current;
        const entries: ConnectionEntry[] = ((await backend.loadManifest()).connections ?? [])
            .map(entry => {
                const connection = live.connections.get(entry.id);
                return connection == null ? entry : { ...entry, name: connection.name, params: connection.params };
            });
        for (const [connectionId, connection] of live.connections) {
            if (!entries.some(entry => entry.id === connectionId) && references.sessionsOf(connectionId).length > 0) {
                entries.push(connectionEntryFromState({ ...connection, paramsDraft: undefined }));
            }
        }
        const plan = planConnectionImport(bundle.session, entries);
        const questions = connectionImportQuestions(plan);
        let choices = new Map<string, ConnectionImportChoice>();
        if (questions.length > 0) {
            const sessionName = bundle.session.name?.trim() || bundle.session.metadata.originalFileName || 'Unnamed session';
            const chosen = await new Promise<Map<string, ConnectionImportChoice> | null>(resolve => {
                setConnectionDialog({ sessionName, questions, resolve });
            });
            setConnectionDialog(null);
            if (chosen == null) return null;
            choices = chosen;
        }
        const session = applyConnectionImportPlan(bundle.session, plan, choices, entries);
        logger.info('resolved the connections of an imported session', {
            sessionId: bundle.session.sessionId,
            connections: plan.map(item => item.decision.kind).join(','),
        }, 'session_import');
        return { ...bundle, session };
    }, [backend, connectionStore, logger, references]);

    const stopSessionWork = React.useCallback(async (sessionId: string) => {
        const databases = references.connectionsOf(sessionId)
            .map(connectionId => connectionStore.current.connections.get(connectionId))
            .filter((database): database is ConnectionState => database != null);
        // Connections may be shared, only the queries of the session are cancelled
        await Promise.all(databases.flatMap(database => findSessionQueries(database, sessionId, false).map(queryId =>
            cancelQuery(database.connectionId, queryId)
        )));
        writer.pause();
        try {
            await writer.flush();
        } catch (error) {
            writer.resume();
            throw error;
        }
    }, [cancelQuery, connectionStore, references, writer]);

    const restoreFreshPortable = React.useCallback(async (
        bundle: SessionBundle,
        targetSessionId: string,
        suffixNameWithCopy: boolean,
    ) => {
        if (backend == null) throw new Error('Session imports require composite storage');
        const importedBundle = suffixNameWithCopy
            ? withFreshIdentity(bundle, targetSessionId)
            : bundle;
        await writePortableSessionFresh(backend, importedBundle, targetSessionId);
        try {
            const core = await setupCore('session_import');
            const restored = await restoreSingleSession(
                core,
                backend,
                logger,
                targetSessionId,
                connectionStore.current,
            );
            setConnections(registry => mergeRestoredSessionIntoConnections(registry, restored));
            setScripts(registry => mergeRestoredSessionIntoScripts(registry, restored));
            return targetSessionId;
        } catch (error) {
            try {
                await backend.deletePortableSession(targetSessionId);
            } catch {
                // Preserve the restoration error.
            }
            throw error;
        }
    }, [backend, connectionStore, logger, setConnections, setScripts, setupCore]);

    const requestConflictChoice = React.useCallback((
        bundle: SessionBundle,
        existingDisplayLocation: string,
        presentation: ImportPresentation,
        run: (choice: ConflictChoice) => Promise<string>,
    ): Promise<string | null> => {
        return new Promise<string | null>(resolve => {
            setDialog(current => {
                if (current != null) {
                    resolve(null);
                    logger.warn('ignored session import while another decision is pending', {}, 'session_import');
                    return current;
                }
                return { bundle, existingDisplayLocation, presentation, busy: false, run, resolve };
            });
        });
    }, [logger]);

    const importPortableBundle = React.useCallback(async (
        bundle: SessionBundle,
        options: PortableSessionImportOptions,
    ): Promise<string | null> => {
        if (backend == null) throw new Error('Session imports require composite storage');
        bundle = await validatePortableBundle(bundle);
        const resolved = await resolveConnections(bundle);
        if (resolved == null) return null;
        bundle = resolved;
        const conflict = await findSessionImportConflict(backend, bundle.session.sessionId);
        if (conflict == null) {
            const sessionId = bundle.session.sessionId;
            if (options.reloadAfterSuccess) {
                await reloadThen(() => writePortableSessionFresh(backend, bundle, sessionId), writer);
            } else {
                await restoreFreshPortable(bundle, sessionId, false);
            }
            return sessionId;
        }

        return await requestConflictChoice(
            bundle,
            displayPath(conflict.sessionId, conflict.location),
            options.presentation,
            async choice => {
                if (choice === 'create-new') {
                    const sessionId = crypto.randomUUID();
                    const importedBundle = withFreshIdentity(bundle, sessionId);
                    if (options.reloadAfterSuccess) {
                        await reloadThen(() => writePortableSessionFresh(backend, importedBundle, sessionId), writer);
                    } else {
                        await restoreFreshPortable(bundle, sessionId, true);
                    }
                    return sessionId;
                }
                await stopSessionWork(conflict.sessionId);
                try {
                    const sessionId = await replaceSessionWithPortableBundle(backend, bundle, conflict);
                    globalThis.location.reload();
                    return sessionId;
                } catch (error) {
                    writer.resume();
                    throw error;
                }
            },
        );
    }, [backend, requestConflictChoice, resolveConnections, restoreFreshPortable, stopSessionWork, validatePortableBundle, writer]);

    const findPortableBundleConflict = React.useCallback(async (bundle: SessionBundle): Promise<{ displayLocation: string; isNative: boolean } | null> => {
        if (backend == null) throw new Error('Session imports require composite storage');
        const conflict = await findSessionImportConflict(backend, bundle.session.sessionId);
        return conflict == null ? null : {
            displayLocation: displayPath(conflict.sessionId, conflict.location),
            isNative: conflict.location.type === StorageBackendType.Native,
        };
    }, [backend]);

    const importPortableBundleWithChoice = React.useCallback(async (
        bundle: SessionBundle,
        choice: ConflictChoice,
    ): Promise<string | null> => {
        if (backend == null) throw new Error('Session imports require composite storage');
        bundle = await validatePortableBundle(bundle);
        const resolved = await resolveConnections(bundle);
        if (resolved == null) return null;
        bundle = resolved;
        const conflict = await findSessionImportConflict(backend, bundle.session.sessionId);
        if (conflict == null) return await restoreFreshPortable(bundle, bundle.session.sessionId, false);
        if (choice === 'create-new') {
            const sessionId = crypto.randomUUID();
            return await restoreFreshPortable(bundle, sessionId, true);
        }
        await stopSessionWork(conflict.sessionId);
        try {
            const sessionId = await replaceSessionWithPortableBundle(backend, bundle, conflict);
            globalThis.location.reload();
            return sessionId;
        } catch (error) {
            writer.resume();
            throw error;
        }
    }, [backend, resolveConnections, restoreFreshPortable, stopSessionWork, validatePortableBundle, writer]);

    const importNativeFolder = React.useCallback(async (
        dir: string,
        presentation: ImportPresentation,
    ): Promise<string | null> => {
        if (backend == null) throw new Error('Native session imports require composite storage');
        const original = await prepareNativeSessionImport(backend, dir);
        const resolved = await resolveConnections(original.bundle);
        if (resolved == null) return null;
        const prepared: PreparedNativeSession = { ...original, bundle: resolved };
        // The folder is registered untouched, references to consolidated connections are written after
        const refsChanged = connectionRefsChanged(original.bundle.session, resolved.session);
        const conflict = await findSessionImportConflict(backend, prepared.bundle.session.sessionId);
        if (conflict == null) {
            await reloadThen(async () => {
                const sessionId = await registerNativeSession(backend, prepared);
                if (refsChanged) await writeNativeConnectionRefs(backend, sessionId, resolved);
                return sessionId;
            }, writer);
            return prepared.bundle.session.sessionId;
        }
        return await requestConflictChoice(
            prepared.bundle,
            displayPath(conflict.sessionId, conflict.location),
            presentation,
            choice => runNativeConflict(choice, prepared, refsChanged, conflict, backend, writer, stopSessionWork),
        );
    }, [backend, requestConflictChoice, resolveConnections, stopSessionWork, writer]);

    const handleChoice = React.useCallback(async (choice: ConflictChoice) => {
        const current = dialog;
        if (current == null || current.busy) return;
        setDialog({ ...current, busy: true });
        try {
            const result = await current.run(choice);
            setDialog(null);
            current.resolve(result);
        } catch (error) {
            logger.error('session import failed', { error: String(error) }, 'session_import');
            setDialog({ ...current, busy: false });
        }
    }, [dialog, logger]);

    const cancelDialog = React.useCallback(() => {
        if (dialog == null || dialog.busy) return;
        setDialog(null);
        dialog.resolve(null);
    }, [dialog]);

    const value = React.useMemo<SessionImportContextValue>(() => ({
        findPortableBundleConflict,
        importPortableBundleWithChoice,
        importPortableBundle,
        importNativeFolder,
    }), [findPortableBundleConflict, importNativeFolder, importPortableBundle, importPortableBundleWithChoice]);

    return (
        <SESSION_IMPORT_CTX.Provider value={value}>
            <div
                aria-hidden={dialog?.presentation.mode === 'centered' || undefined}
                style={{ display: dialog?.presentation.mode === 'centered' ? 'none' : 'contents' }}
            >
                {props.children}
            </div>
            {dialog?.presentation.mode === 'centered' && renderConflictDialog(dialog, handleChoice, cancelDialog)}
            {dialog?.presentation.mode === 'anchored' && renderConflictDialog(dialog, handleChoice, cancelDialog)}
            {connectionDialog != null && (
                <SessionConnectionImportDialog
                    sessionName={connectionDialog.sessionName}
                    questions={connectionDialog.questions}
                    busy={false}
                    onConfirm={choices => connectionDialog.resolve(choices)}
                    onCancel={() => connectionDialog.resolve(null)}
                />
            )}
        </SESSION_IMPORT_CTX.Provider>
    );
}

/// Give an imported session a new identity.
/// The connections keep their ids, the connections of the copy were resolved by the import.
function withFreshIdentity(bundle: SessionBundle, sessionId: string): SessionBundle {
    const session = { ...bundle.session, sessionId };
    const name = session.name?.trim();
    if (name) session.name = `${name} (copy)`;
    return { ...bundle, session };
}

async function reloadThen<T>(operation: () => Promise<T>, writer: ReturnType<typeof useStorage>[1]): Promise<T> {
    writer.pause();
    try {
        await writer.flush();
        const result = await operation();
        globalThis.location.reload();
        return result;
    } catch (error) {
        writer.resume();
        throw error;
    }
}

/// Write the resolved connection references into a registered native folder
async function writeNativeConnectionRefs(backend: CompositeStorageBackend, sessionId: string, bundle: SessionBundle): Promise<void> {
    const existing = await backend.loadSession(sessionId);
    await backend.saveSessionManifest(sessionId, {
        ...existing,
        defaultConnectionId: bundle.session.defaultConnectionId,
        connections: bundle.session.connections,
        scripts: bundle.session.scripts,
    });
}

async function runNativeConflict(
    choice: ConflictChoice,
    prepared: PreparedNativeSession,
    refsChanged: boolean,
    conflict: SessionImportConflict,
    backend: CompositeStorageBackend,
    writer: ReturnType<typeof useStorage>[1],
    stopSessionWork: (sessionId: string) => Promise<void>,
): Promise<string> {
    if (choice === 'create-new') {
        const sessionId = crypto.randomUUID();
        const bundle = withFreshIdentity(prepared.bundle, sessionId);
        return await reloadThen(() => writePortableSessionFresh(backend, bundle, sessionId), writer);
    }
    await stopSessionWork(conflict.sessionId);
    try {
        const sessionId = await replaceSessionWithNativeFolder(backend, prepared, conflict);
        if (refsChanged) await writeNativeConnectionRefs(backend, sessionId, prepared.bundle);
        globalThis.location.reload();
        return sessionId;
    } catch (error) {
        writer.resume();
        throw error;
    }
}

function renderConflictDialog(
    dialog: ConflictDialogState,
    handleChoice: (choice: ConflictChoice) => Promise<void>,
    onCancel: () => void,
): React.ReactElement {
    const common = {
        sessionName: dialog.bundle.session.name?.trim()
            || dialog.bundle.session.metadata.originalFileName
            || 'Unnamed session',
        sessionUuid: dialog.bundle.session.sessionId,
        folderCount: 0,
        scriptCount: dialog.bundle.scripts.length,
        existingDisplayLocation: dialog.existingDisplayLocation,
        existingIsNative: getAppHost() === AppHost.ELECTRON && dialog.existingDisplayLocation.startsWith('fs://'),
        busy: dialog.busy,
        onReplace: () => void handleChoice('replace'),
        onCreateNew: () => void handleChoice('create-new'),
        onCancel,
    };
    return dialog.presentation.mode === 'centered'
        ? <SessionImportConflictDialog mode="centered" {...common} />
        : <SessionImportConflictDialog
            mode="anchored"
            anchorRef={dialog.presentation.anchorRef}
            returnFocusRef={dialog.presentation.returnFocusRef}
            {...common}
        />;
}
