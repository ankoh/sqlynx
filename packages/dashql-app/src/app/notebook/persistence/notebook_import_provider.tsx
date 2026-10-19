import * as React from 'react';

import { filterInvalidNotebookCatalogs, regenerateNotebookDatabaseIds, type NotebookBundle } from './notebook_bundle.js';
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
import { useAttachedDatabaseRegistry } from '../connections/attached_database_registry.js';
import type { AttachedDatabaseState } from '../connections/attached_database_state.js';
import { useNotebookScriptsRegistrySetter } from '../scripts/notebook_scripts_registry.js';
import { useDashQLCoreSetup } from '../../providers/core_provider.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import { useCancelQuery } from '../connections/query_executor.js';
import { NotebookImportConflictDialog } from '../ui/notebook_import_conflict_dialog.js';
import { StorageBackendType } from './storage_backend.js';
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
    importPortableBundleWithChoice(bundle: NotebookBundle, choice: ConflictChoice): Promise<string>;
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
    const [connections, setConnections] = useAttachedDatabaseRegistry();
    const setScripts = useNotebookScriptsRegistrySetter();
    const cancelQuery = useCancelQuery();
    const [dialog, setDialog] = React.useState<ConflictDialogState | null>(null);

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

    const stopNotebookWork = React.useCallback(async (notebookId: string) => {
        const mapping = connections.attachedDatabasesByNotebook.get(notebookId);
        const databases = mapping == null ? [] : [mapping.mainDatabaseId, ...mapping.attachedDatabaseIds]
            .filter((databaseId): databaseId is string => databaseId != null)
            .map(databaseId => connections.attachedDatabases.get(databaseId))
            .filter((database): database is AttachedDatabaseState => database != null);
        await Promise.all(databases.flatMap(database => database.queriesActiveOrdered.map(queryId =>
            cancelQuery(database.databaseId, queryId)
        )));
        writer.pause();
        try {
            await writer.flush();
        } catch (error) {
            writer.resume();
            throw error;
        }
    }, [cancelQuery, connections, writer]);

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
                connections.attachedDatabasesBySignature,
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
    }, [backend, connections.attachedDatabasesBySignature, logger, setConnections, setScripts, setupCore]);

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
    }, [backend, requestConflictChoice, restoreFreshPortable, stopNotebookWork, validatePortableBundle, writer]);

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
    ): Promise<string> => {
        if (backend == null) throw new Error('Notebook imports require composite storage');
        bundle = await validatePortableBundle(bundle);
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
    }, [backend, restoreFreshPortable, stopNotebookWork, validatePortableBundle, writer]);

    const importNativeFolder = React.useCallback(async (
        dir: string,
        presentation: ImportPresentation,
    ): Promise<string | null> => {
        if (backend == null) throw new Error('Native notebook imports require composite storage');
        const prepared = await prepareNativeNotebookImport(backend, dir);
        const conflict = await findNotebookImportConflict(backend, prepared.bundle.notebook.notebookId);
        if (conflict == null) {
            await reloadThen(() => registerNativeNotebook(backend, prepared), writer);
            return prepared.bundle.notebook.notebookId;
        }
        return await requestConflictChoice(
            prepared.bundle,
            displayPath(conflict.notebookId, conflict.location),
            presentation,
            choice => runNativeConflict(choice, prepared, conflict, backend, writer, stopNotebookWork),
        );
    }, [backend, requestConflictChoice, stopNotebookWork, writer]);

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
        </NOTEBOOK_IMPORT_CTX.Provider>
    );
}

function withFreshIdentity(bundle: NotebookBundle, notebookId: string): NotebookBundle {
    const notebook = regenerateNotebookDatabaseIds({
        ...bundle.notebook,
        notebookId,
    });
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

async function runNativeConflict(
    choice: ConflictChoice,
    prepared: PreparedNativeNotebook,
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
