import * as React from 'react';

import { filterInvalidNotebookCatalogs, type NotebookBundle } from './notebook_bundle.js';
import type { PreparedNativeNotebook } from './composite_storage_backend.js';
import { CompositeStorageBackend } from './composite_storage_backend.js';
import {
    findNotebookImportConflict,
    type NotebookImportConflict,
    prepareNativeNotebookImport,
    registerNativeNotebook,
    replaceNotebookWithNativeFolder,
    replaceNotebookWithPortableBundle,
    writePortableNotebookFresh,
} from './notebook_import_transaction.js';
import { displayPath } from './notebook_locator.js';
import { useStorage } from './storage_provider.js';
import { restoreSingleNotebook } from './app_state_loader.js';
import { mergeRestoredNotebookIntoConnections, mergeRestoredNotebookIntoScripts } from './app_state_loader.js';
import { connectionRefCount, findNotebookQueries, useAttachedDatabaseRegistrySetter, useAttachedDatabaseRegistryStore } from '../connections/attached_database_registry.js';
import type { AttachedDatabaseState } from '../connections/attached_database_state.js';
import { useNotebookScriptsRegistrySetter } from '../scripts/notebook_scripts_registry.js';
import { useDashQLCoreSetup } from '../../providers/core_provider.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import { useCancelQuery } from '../connections/query_executor.js';
import { NotebookImportConflictDialog } from '../ui/notebook_import_conflict_dialog.js';
import { NotebookConnectionImportDialog } from '../ui/notebook_connection_import_dialog.js';
import { StorageBackendType, type ConnectionEntry } from './storage_backend.js';
import {
    applyConnectionImportPlan,
    connectionImportQuestions,
    connectionRefsChanged,
    planConnectionImport,
    type ConnectionImportChoice,
    type ConnectionImportPlanItem,
} from './notebook_connection_import.js';
import { AppHost, getAppHost } from '../../../platform/native_globals.js';

type ImportPresentation =
    | { mode: 'centered' }
    | {
        mode: 'anchored';
        anchorRef: React.RefObject<Element | null>;
        returnFocusRef: React.RefObject<HTMLElement | null>;
    };

export interface PortableNotebookImportOptions {
    presentation: ImportPresentation;
    reloadAfterSuccess?: boolean;
}

interface NotebookImportContextValue {
    findPortableBundleConflict(bundle: NotebookBundle): Promise<{ displayLocation: string; isNative: boolean } | null>;
    importPortableBundleWithChoice(bundle: NotebookBundle, choice: ConflictChoice): Promise<string | null>;
    importPortableBundle(bundle: NotebookBundle, options: PortableNotebookImportOptions): Promise<string | null>;
    importNativeFolder(dir: string, presentation: ImportPresentation): Promise<string | null>;
}

type ConflictChoice = 'replace' | 'create-new';

interface ConflictDialogState {
    bundle: NotebookBundle;
    existingDisplayLocation: string;
    presentation: ImportPresentation;
    busy: boolean;
    run(choice: ConflictChoice): Promise<string>;
    resolve(value: string | null): void;
}

/// The question whether imported connections should use existing connections
interface ConnectionDialogState {
    /// The name of the imported notebook
    notebookName: string;
    /// The connections that may consolidate
    questions: ConnectionImportPlanItem[];
    /// Resolve with the choices, null if the import was cancelled
    resolve(choices: Map<string, ConnectionImportChoice> | null): void;
}

const NOTEBOOK_IMPORT_CTX = React.createContext<NotebookImportContextValue | null>(null);

export function useNotebookImport(): NotebookImportContextValue {
    const value = React.useContext(NOTEBOOK_IMPORT_CTX);
    if (value == null) throw new Error('useNotebookImport must be used within NotebookImportProvider');
    return value;
}

export function NotebookImportProvider(props: React.PropsWithChildren) {
    const logger = useLogger();
    const setupCore = useDashQLCoreSetup();
    const [reader, writer] = useStorage();
    // Read the registry when importing instead of re-creating the import context for every query event
    const connectionStore = useAttachedDatabaseRegistryStore();
    const setConnections = useAttachedDatabaseRegistrySetter();
    const setScripts = useNotebookScriptsRegistrySetter();
    const cancelQuery = useCancelQuery();
    const [dialog, setDialog] = React.useState<ConflictDialogState | null>(null);
    const [connectionDialog, setConnectionDialog] = React.useState<ConnectionDialogState | null>(null);

    const backend = reader.backend instanceof CompositeStorageBackend ? reader.backend : null;

    const validatePortableBundle = React.useCallback(async (bundle: NotebookBundle): Promise<NotebookBundle> => {
        const core = await setupCore('notebook_import_validation');
        const validation = filterInvalidNotebookCatalogs(core, bundle);
        if (validation.invalidFiles.length > 0) {
            logger.warn('ignored malformed notebook catalog files', {
                notebookId: bundle.notebook.notebookId,
                files: validation.invalidFiles.join(', '),
            }, 'notebook_import');
        }
        return validation.bundle;
    }, [logger, setupCore]);

    /// Map the connections of an imported notebook to the connections of the app.
    /// Connections that may consolidate with existing ones are decided by the user, null if the
    /// user cancelled the import.
    const resolveConnections = React.useCallback(async (bundle: NotebookBundle): Promise<NotebookBundle | null> => {
        if (backend == null) return bundle;
        // The live connections may be ahead of the manifest while writes are debounced
        const live = connectionStore.current;
        const entries: ConnectionEntry[] = ((await backend.loadManifest()).connections ?? [])
            .map(entry => ({ ...entry, params: live.attachedDatabases.get(entry.id)?.params ?? entry.params }));
        for (const [connectionId, connection] of live.attachedDatabases) {
            if (!entries.some(entry => entry.id === connectionId) && connectionRefCount(live, connectionId) > 0) {
                entries.push({ id: connectionId, params: connection.params });
            }
        }
        const plan = planConnectionImport(bundle.notebook, entries);
        const questions = connectionImportQuestions(plan);
        let choices = new Map<string, ConnectionImportChoice>();
        if (questions.length > 0) {
            const notebookName = bundle.notebook.name?.trim() || bundle.notebook.metadata.originalFileName || 'Unnamed notebook';
            const chosen = await new Promise<Map<string, ConnectionImportChoice> | null>(resolve => {
                setConnectionDialog({ notebookName, questions, resolve });
            });
            setConnectionDialog(null);
            if (chosen == null) return null;
            choices = chosen;
        }
        const notebook = applyConnectionImportPlan(bundle.notebook, plan, choices, entries);
        logger.info('resolved the connections of an imported notebook', {
            notebookId: bundle.notebook.notebookId,
            connections: plan.map(item => item.decision.kind).join(','),
        }, 'notebook_import');
        return { ...bundle, notebook };
    }, [backend, connectionStore, logger]);

    const stopNotebookWork = React.useCallback(async (notebookId: string) => {
        const connections = connectionStore.current;
        const mapping = connections.attachedDatabasesByNotebook.get(notebookId);
        const databases = mapping == null ? [] : [mapping.mainDatabaseId, ...mapping.attachedDatabaseIds]
            .filter((databaseId): databaseId is string => databaseId != null)
            .map(databaseId => connections.attachedDatabases.get(databaseId))
            .filter((database): database is AttachedDatabaseState => database != null);
        // Connections may be shared, only the queries of the notebook are cancelled
        await Promise.all(databases.flatMap(database => findNotebookQueries(database, notebookId, false).map(queryId =>
            cancelQuery(database.databaseId, queryId)
        )));
        writer.pause();
        try {
            await writer.flush();
        } catch (error) {
            writer.resume();
            throw error;
        }
    }, [cancelQuery, connectionStore, writer]);

    const restoreFreshPortable = React.useCallback(async (
        bundle: NotebookBundle,
        targetNotebookId: string,
        suffixNameWithCopy: boolean,
    ) => {
        if (backend == null) throw new Error('Notebook imports require composite storage');
        const importedBundle = suffixNameWithCopy
            ? withFreshIdentity(bundle, targetNotebookId)
            : bundle;
        await writePortableNotebookFresh(backend, importedBundle, targetNotebookId);
        try {
            const core = await setupCore('notebook_import');
            const restored = await restoreSingleNotebook(
                core,
                backend,
                logger,
                targetNotebookId,
                connectionStore.current,
            );
            setConnections(registry => mergeRestoredNotebookIntoConnections(registry, restored));
            setScripts(registry => mergeRestoredNotebookIntoScripts(registry, restored));
            return targetNotebookId;
        } catch (error) {
            try {
                await backend.deletePortableNotebook(targetNotebookId);
            } catch {
                // Preserve the restoration error.
            }
            throw error;
        }
    }, [backend, connectionStore, logger, setConnections, setScripts, setupCore]);

    const requestConflictChoice = React.useCallback((
        bundle: NotebookBundle,
        existingDisplayLocation: string,
        presentation: ImportPresentation,
        run: (choice: ConflictChoice) => Promise<string>,
    ): Promise<string | null> => {
        return new Promise<string | null>(resolve => {
            setDialog(current => {
                if (current != null) {
                    resolve(null);
                    logger.warn('ignored notebook import while another decision is pending', {}, 'notebook_import');
                    return current;
                }
                return { bundle, existingDisplayLocation, presentation, busy: false, run, resolve };
            });
        });
    }, [logger]);

    const importPortableBundle = React.useCallback(async (
        bundle: NotebookBundle,
        options: PortableNotebookImportOptions,
    ): Promise<string | null> => {
        if (backend == null) throw new Error('Notebook imports require composite storage');
        bundle = await validatePortableBundle(bundle);
        const resolved = await resolveConnections(bundle);
        if (resolved == null) return null;
        bundle = resolved;
        const conflict = await findNotebookImportConflict(backend, bundle.notebook.notebookId);
        if (conflict == null) {
            const notebookId = bundle.notebook.notebookId;
            if (options.reloadAfterSuccess) {
                await reloadThen(() => writePortableNotebookFresh(backend, bundle, notebookId), writer);
            } else {
                await restoreFreshPortable(bundle, notebookId, false);
            }
            return notebookId;
        }

        return await requestConflictChoice(
            bundle,
            displayPath(conflict.notebookId, conflict.location),
            options.presentation,
            async choice => {
                if (choice === 'create-new') {
                    const notebookId = crypto.randomUUID();
                    const importedBundle = withFreshIdentity(bundle, notebookId);
                    if (options.reloadAfterSuccess) {
                        await reloadThen(() => writePortableNotebookFresh(backend, importedBundle, notebookId), writer);
                    } else {
                        await restoreFreshPortable(bundle, notebookId, true);
                    }
                    return notebookId;
                }
                await stopNotebookWork(conflict.notebookId);
                try {
                    const notebookId = await replaceNotebookWithPortableBundle(backend, bundle, conflict);
                    globalThis.location.reload();
                    return notebookId;
                } catch (error) {
                    writer.resume();
                    throw error;
                }
            },
        );
    }, [backend, requestConflictChoice, resolveConnections, restoreFreshPortable, stopNotebookWork, validatePortableBundle, writer]);

    const findPortableBundleConflict = React.useCallback(async (bundle: NotebookBundle): Promise<{ displayLocation: string; isNative: boolean } | null> => {
        if (backend == null) throw new Error('Notebook imports require composite storage');
        const conflict = await findNotebookImportConflict(backend, bundle.notebook.notebookId);
        return conflict == null ? null : {
            displayLocation: displayPath(conflict.notebookId, conflict.location),
            isNative: conflict.location.type === StorageBackendType.Native,
        };
    }, [backend]);

    const importPortableBundleWithChoice = React.useCallback(async (
        bundle: NotebookBundle,
        choice: ConflictChoice,
    ): Promise<string | null> => {
        if (backend == null) throw new Error('Notebook imports require composite storage');
        bundle = await validatePortableBundle(bundle);
        const resolved = await resolveConnections(bundle);
        if (resolved == null) return null;
        bundle = resolved;
        const conflict = await findNotebookImportConflict(backend, bundle.notebook.notebookId);
        if (conflict == null) return await restoreFreshPortable(bundle, bundle.notebook.notebookId, false);
        if (choice === 'create-new') {
            const notebookId = crypto.randomUUID();
            return await restoreFreshPortable(bundle, notebookId, true);
        }
        await stopNotebookWork(conflict.notebookId);
        try {
            const notebookId = await replaceNotebookWithPortableBundle(backend, bundle, conflict);
            globalThis.location.reload();
            return notebookId;
        } catch (error) {
            writer.resume();
            throw error;
        }
    }, [backend, resolveConnections, restoreFreshPortable, stopNotebookWork, validatePortableBundle, writer]);

    const importNativeFolder = React.useCallback(async (
        dir: string,
        presentation: ImportPresentation,
    ): Promise<string | null> => {
        if (backend == null) throw new Error('Native notebook imports require composite storage');
        const original = await prepareNativeNotebookImport(backend, dir);
        const resolved = await resolveConnections(original.bundle);
        if (resolved == null) return null;
        const prepared: PreparedNativeNotebook = { ...original, bundle: resolved };
        // The folder is registered untouched, references to consolidated connections are written after
        const refsChanged = connectionRefsChanged(original.bundle.notebook, resolved.notebook);
        const conflict = await findNotebookImportConflict(backend, prepared.bundle.notebook.notebookId);
        if (conflict == null) {
            await reloadThen(async () => {
                const notebookId = await registerNativeNotebook(backend, prepared);
                if (refsChanged) await writeNativeConnectionRefs(backend, notebookId, resolved);
                return notebookId;
            }, writer);
            return prepared.bundle.notebook.notebookId;
        }
        return await requestConflictChoice(
            prepared.bundle,
            displayPath(conflict.notebookId, conflict.location),
            presentation,
            choice => runNativeConflict(choice, prepared, refsChanged, conflict, backend, writer, stopNotebookWork),
        );
    }, [backend, requestConflictChoice, resolveConnections, stopNotebookWork, writer]);

    const handleChoice = React.useCallback(async (choice: ConflictChoice) => {
        const current = dialog;
        if (current == null || current.busy) return;
        setDialog({ ...current, busy: true });
        try {
            const result = await current.run(choice);
            setDialog(null);
            current.resolve(result);
        } catch (error) {
            logger.error('notebook import failed', { error: String(error) }, 'notebook_import');
            setDialog({ ...current, busy: false });
        }
    }, [dialog, logger]);

    const cancelDialog = React.useCallback(() => {
        if (dialog == null || dialog.busy) return;
        setDialog(null);
        dialog.resolve(null);
    }, [dialog]);

    const value = React.useMemo<NotebookImportContextValue>(() => ({
        findPortableBundleConflict,
        importPortableBundleWithChoice,
        importPortableBundle,
        importNativeFolder,
    }), [findPortableBundleConflict, importNativeFolder, importPortableBundle, importPortableBundleWithChoice]);

    return (
        <NOTEBOOK_IMPORT_CTX.Provider value={value}>
            <div
                aria-hidden={dialog?.presentation.mode === 'centered' || undefined}
                style={{ display: dialog?.presentation.mode === 'centered' ? 'none' : 'contents' }}
            >
                {props.children}
            </div>
            {dialog?.presentation.mode === 'centered' && renderConflictDialog(dialog, handleChoice, cancelDialog)}
            {dialog?.presentation.mode === 'anchored' && renderConflictDialog(dialog, handleChoice, cancelDialog)}
            {connectionDialog != null && (
                <NotebookConnectionImportDialog
                    notebookName={connectionDialog.notebookName}
                    questions={connectionDialog.questions}
                    busy={false}
                    onConfirm={choices => connectionDialog.resolve(choices)}
                    onCancel={() => connectionDialog.resolve(null)}
                />
            )}
        </NOTEBOOK_IMPORT_CTX.Provider>
    );
}

/// Give an imported notebook a new identity.
/// The connections keep their ids, the connections of the copy were resolved by the import.
function withFreshIdentity(bundle: NotebookBundle, notebookId: string): NotebookBundle {
    const notebook = { ...bundle.notebook, notebookId };
    const name = notebook.name?.trim();
    if (name) notebook.name = `${name} (copy)`;
    return { ...bundle, notebook };
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
async function writeNativeConnectionRefs(backend: CompositeStorageBackend, notebookId: string, bundle: NotebookBundle): Promise<void> {
    const existing = await backend.loadNotebook(notebookId);
    await backend.saveNotebookManifest(notebookId, {
        ...existing,
        mainDatabase: bundle.notebook.mainDatabase,
        attachedDatabases: bundle.notebook.attachedDatabases,
    });
}

async function runNativeConflict(
    choice: ConflictChoice,
    prepared: PreparedNativeNotebook,
    refsChanged: boolean,
    conflict: NotebookImportConflict,
    backend: CompositeStorageBackend,
    writer: ReturnType<typeof useStorage>[1],
    stopNotebookWork: (notebookId: string) => Promise<void>,
): Promise<string> {
    if (choice === 'create-new') {
        const notebookId = crypto.randomUUID();
        const bundle = withFreshIdentity(prepared.bundle, notebookId);
        return await reloadThen(() => writePortableNotebookFresh(backend, bundle, notebookId), writer);
    }
    await stopNotebookWork(conflict.notebookId);
    try {
        const notebookId = await replaceNotebookWithNativeFolder(backend, prepared, conflict);
        if (refsChanged) await writeNativeConnectionRefs(backend, notebookId, prepared.bundle);
        globalThis.location.reload();
        return notebookId;
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
        notebookName: dialog.bundle.notebook.name?.trim()
            || dialog.bundle.notebook.metadata.originalFileName
            || 'Unnamed notebook',
        notebookUuid: dialog.bundle.notebook.notebookId,
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
        ? <NotebookImportConflictDialog mode="centered" {...common} />
        : <NotebookImportConflictDialog
            mode="anchored"
            anchorRef={dialog.presentation.anchorRef}
            returnFocusRef={dialog.presentation.returnFocusRef}
            {...common}
        />;
}
