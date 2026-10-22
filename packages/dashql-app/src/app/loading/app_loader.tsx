import * as React from 'react';

import { AppLoadingStatus } from '../router/app_loading_status.js';
import { OPEN_LINK_NOTEBOOK, SELECT_NOTEBOOK, useRouteContext, useRouterNavigate } from '../router/router.js';
import { resolveNotebookExecutionDatabase, useAttachedDatabaseDispatch, useAttachedDatabaseRegistry, useAttachedDatabaseStateAllocator } from '../notebook/connections/attached_database_registry.js';
import { useDashQLCoreSetup } from '../providers/core_provider.js';
import { useLogger } from '../../platform/logger/logger_provider.js';
import { createTrace } from '../../platform/logger/trace_context.js';
import { usePlatformEventListener } from '../../platform/events/event_listener_provider.js';
import { useNotebookScriptsSetup } from '../notebook/scripts/notebook_scripts_setup.js';
import { AppLoadingPage } from '../ui/app_loading_page.js';
import { SETUP_NOTEBOOK, SETUP_NOTEBOOK_URL, SetupEventVariant } from '../../platform/events/event.js';
import { AppLoadingProgress } from './app_loading_progress.js';
import { ProgressCounter } from '../../utils/progress.js';
import { canShowNotebook, loadApp, selectStartupNotebook, shouldFinishInitialNavigation } from './app_loading_logic.js';
import { useAppConfig, useAppReconfigure } from '../config/app_config.js';
import { useStorage } from '../notebook/persistence/storage_provider.js';
import { groupNotebookManifestWrites, WRITE_NOTEBOOK_MANIFEST } from '../notebook/persistence/storage_writer.js';
import { useNotebookScriptsRegistrySetter } from '../notebook/scripts/notebook_scripts_registry.js';
import { useEmbeddedDatabaseSetup } from '../../platform/database/embedded_database_provider.js';
import { InvalidNotebook } from '../notebook/persistence/notebook_validation.js';
import { AppHost, getAppHost } from '../../platform/native_globals.js';
import { readNotebookBundleFromZip } from '../notebook/persistence/notebook_import.js';
import { useNotebookImport } from '../notebook/persistence/notebook_import_provider.js';
import { useHttpClient } from '../../platform/http/http_client_provider.js';
import {
    readNotebookBundleFromHttp,
    type HttpNotebookLoadProgress,
    type HttpNotebookLoadResult,
} from '../notebook/persistence/http_notebook_bundle.js';
import { stringifyError } from '../../platform/logger/logger.js';
import { NotebookImportCard } from '../notebook/ui/notebook_import_card.js';
import { IndicatorStatus } from '../../ui/foundations/status_indicator.js';
import { createDefaultHyperWasmAttachedDatabaseState } from '../notebook/connections/connection_params.js';
import { useAppSettingsReady } from '../config/app_settings_sync.js';
import { InvalidNotebookRegistryProvider } from '../notebook/persistence/invalid_notebook_registry.js';
import { useHyperSetup } from '../notebook/connections/hyper/hyper_connection_setup.js';
import { useInitialMemorySetup } from './initial_memory_setup.js';
import { NotebookSetupStatus } from '../router/notebook_setup_status.js';
import { NarrowScreenWarning, useNarrowScreenWarning } from '../ui/narrow_screen_warning.js';

async function loadFonts(): Promise<void> {
    // The font families are theme tokens that the app flavor may override
    const style = getComputedStyle(document.documentElement);
    const family = style.getPropertyValue('--font_family').trim() || "'Roboto'";
    const familyMono = style.getPropertyValue('--font_family_mono').trim() || "'Roboto Mono'";
    await Promise.all([
        document.fonts.load(`300 16px ${family}`),
        document.fonts.load(`400 16px ${family}`),
        document.fonts.load(`500 16px ${family}`),
        document.fonts.load(`700 16px ${family}`),
        document.fonts.load(`400 16px ${familyMono}`),
        document.fonts.load(`500 16px ${familyMono}`),
        document.fonts.load(`700 16px ${familyMono}`),
    ]);
}

interface Props { }

export const AppLoader: React.FC<React.PropsWithChildren<Props>> = (props: React.PropsWithChildren<Props>) => {
    const config = useAppConfig();
    const appSettingsReady = useAppSettingsReady();
    const reconfigure = useAppReconfigure();
    const showNarrowScreenWarning = useNarrowScreenWarning(appSettingsReady, config?.settings?.narrowScreenLayout ?? false);
    const logger = useLogger();
    const navigate = useRouterNavigate();
    const routeContext = useRouteContext();
    const setupCore = useDashQLCoreSetup();
    const setupNotebookScripts = useNotebookScriptsSetup();
    const [storageReader, storageWriter] = useStorage();
    const allocateAttachedDatabase = useAttachedDatabaseStateAllocator();
    const [connReg, setConnReg] = useAttachedDatabaseRegistry();
    const dispatchDatabase = useAttachedDatabaseDispatch();
    const setNotebookScriptsRegistry = useNotebookScriptsRegistrySetter();
    const setupEmbeddedDatabase = useEmbeddedDatabaseSetup();
    const hyperSetup = useHyperSetup();

    const appEvents = usePlatformEventListener();
    const notebookImport = useNotebookImport();
    const httpClient = useHttpClient();
    const [embeddedDatabaseStatus, setEmbeddedDatabaseStatus] = React.useState<IndicatorStatus>(IndicatorStatus.None);
    const [loadedNotebook, setLoadedNotebook] = React.useState<HttpNotebookLoadResult | null>(null);
    const [loadedNotebookConflict, setLoadedNotebookConflict] = React.useState<{
        displayLocation: string;
        isNative: boolean;
    } | null>(null);
    const [loadedNotebookBusy, setLoadedNotebookBusy] = React.useState(false);
    const [remoteNotebookLoading, setRemoteNotebookLoading] = React.useState<{
        sourceUrl: string;
        progress: HttpNotebookLoadProgress;
    } | null>(null);
    const remoteNotebookAbortRef = React.useRef<AbortController | null>(null);
    // Normal startup must not replace the route selected by an inline notebook import.
    const initialInlineSetupRef = React.useRef<Promise<boolean> | null>(null);
    // Notebooks whose metadata was refused a load. Surfaced (marked invalid, blocked, deletable) in
    // the notebook workbench instead of being silently dropped.
    const [invalidNotebooks, setInvalidNotebooks] = React.useState<Map<string, InvalidNotebook>>(() => new Map());
    const [loadingProgress, setLoadingProgress] = React.useState<AppLoadingProgress>(() => ({
        restoreConnections: new ProgressCounter(),
        restoreCatalogs: new ProgressCounter(),
        restoreNotebookScripts: new ProgressCounter(),
    }));
    const [setupDone, resolveSetupDone, _rejectSetupDone] = React.useMemo(() => {
        let resolve: () => void;
        let reject: (e: Error) => void;
        const promise = new Promise<void>((a, b) => {
            resolve = a;
            reject = b
        });
        return [promise, resolve!, reject!];
    }, []);

    React.useEffect(() => {
        if (routeContext.notebookSetupStatus === NotebookSetupStatus.OPENING && routeContext.notebookId != null) {
            navigate({ type: SELECT_NOTEBOOK, value: routeContext.notebookId });
        }
    }, [navigate, routeContext.notebookId, routeContext.notebookSetupStatus]);

    useInitialMemorySetup(
        routeContext.notebookId,
        routeContext.notebookId == null ? null : resolveNotebookExecutionDatabase(connReg, routeContext.notebookId),
        hyperSetup,
        dispatchDatabase,
        logger,
    );

    // Callback to consume setup event.
    // This function is called through os deep links and when opening DashQL by through .dashql files
    const consumeSetupEvent = React.useEffectEvent(async (data: SetupEventVariant): Promise<boolean> => {
        // Start trace for setup event handling
        const traced = logger.withTrace(createTrace());
        traced.debug("Consuming setup event", { "event_type": String(data.type) }, "app_loader");

        let remoteAbort: AbortController | null = null;
        let remoteLoad: Promise<HttpNotebookLoadResult> | null = null;
        if (data.type === SETUP_NOTEBOOK_URL) {
            remoteNotebookAbortRef.current?.abort();
            remoteAbort = new AbortController();
            remoteNotebookAbortRef.current = remoteAbort;
            setRemoteNotebookLoading({ sourceUrl: data.value, progress: { phase: 'preparing' } });
            setLoadedNotebook(null);
            setLoadedNotebookConflict(null);
            traced.info('Loading shared notebook', { sourceUrl: data.value }, 'app_loader');
            remoteLoad = readNotebookBundleFromHttp(
                new URL(data.value),
                httpClient,
                remoteAbort.signal,
                progress => {
                    if (remoteNotebookAbortRef.current === remoteAbort) {
                        setRemoteNotebookLoading({ sourceUrl: data.value, progress });
                    }
                },
            );
        }

        // Remote notebook I/O can proceed while the application initializes. Import and conflict
        // detection still wait for setup because they use the initialized storage registry.
        const setup = Promise.all([setupCore("app_setup"), setupDone]);
        const remoteResult = remoteLoad == null ? null : await remoteLoad;
        await setup;
        remoteAbort?.signal.throwIfAborted();
        if (data.type === SETUP_NOTEBOOK) {
            const zipBlob = new Blob([data.value.buffer as ArrayBuffer], { type: 'application/zip' });
            const bundle = await readNotebookBundleFromZip(zipBlob);
            const notebookId = await notebookImport.importPortableBundle(bundle, {
                presentation: { mode: 'centered' },
            });
            if (notebookId != null) {
                traced.debug("Finished link setup", { notebookId }, "app_loader");
                navigate({ type: OPEN_LINK_NOTEBOOK, value: notebookId });
                return true;
            }
        } else if (data.type === SETUP_NOTEBOOK_URL) {
            const result = remoteResult!;
            if (remoteNotebookAbortRef.current === remoteAbort) {
                traced.info('Loaded shared notebook', {
                    notebookId: result.bundle.notebook.notebookId,
                    loadedScriptCount: String(result.loadedScriptCount),
                    indexedScriptCount: String(result.indexedScriptCount),
                    incomplete: String(result.incomplete),
                }, 'app_loader');
                const conflictLocation = await notebookImport.findPortableBundleConflict(result.bundle);
                remoteAbort!.signal.throwIfAborted();
                if (remoteNotebookAbortRef.current !== remoteAbort) return false;
                traced.info('Checked shared notebook import conflict', {
                    notebookId: result.bundle.notebook.notebookId,
                    conflict: String(conflictLocation != null),
                    existingLocation: conflictLocation?.displayLocation ?? '',
                }, 'app_loader');
                remoteNotebookAbortRef.current = null;
                setRemoteNotebookLoading(null);
                setLoadedNotebookConflict(conflictLocation);
                setLoadedNotebook(result);
            }
            return false;
        }
        return false;
    });

    const cancelRemoteNotebookLoad = React.useCallback(() => {
        remoteNotebookAbortRef.current?.abort();
        remoteNotebookAbortRef.current = null;
        setRemoteNotebookLoading(null);
    }, []);

    const importLoadedNotebook = React.useCallback((choice?: 'replace' | 'create-new') => {
        if (loadedNotebook == null || loadedNotebookBusy) return;
        setLoadedNotebookBusy(true);
        const result = loadedNotebook;
        const importChoice = choice ?? 'import';
        logger.info('Importing shared notebook', {
            notebookId: result.bundle.notebook.notebookId,
            choice: importChoice,
        }, 'app_loader');
        const importPromise = choice == null
            ? notebookImport.importPortableBundleWithChoice(result.bundle, 'create-new')
            : notebookImport.importPortableBundleWithChoice(result.bundle, choice);
        void importPromise.then(notebookId => {
            logger.info('Imported shared notebook', {
                sourceNotebookId: result.bundle.notebook.notebookId,
                notebookId,
                choice: importChoice,
            }, 'app_loader');
            setLoadedNotebook(null);
            setLoadedNotebookConflict(null);
            navigate({ type: OPEN_LINK_NOTEBOOK, value: notebookId });
        }).catch(error => {
            logger.error('Failed to import loaded notebook', { error: stringifyError(error) }, 'app_loader');
        }).finally(() => setLoadedNotebookBusy(false));
    }, [loadedNotebook, loadedNotebookBusy, logger, navigate, notebookImport]);

    const cancelLoadedNotebook = React.useCallback(() => {
        if (loadedNotebookBusy) return;
        setLoadedNotebook(null);
        setLoadedNotebookConflict(null);
    }, [loadedNotebookBusy]);

    const handleSetupEvent = React.useEffectEvent((data: SetupEventVariant) => {
        const handling = consumeSetupEvent(data).catch(error => {
            if ((error as Error)?.name === 'AbortError') return false;
            remoteNotebookAbortRef.current = null;
            setRemoteNotebookLoading(null);
            logger.error('Failed to open shared notebook', { error: stringifyError(error) }, 'app_loader');
            return false;
        });
        if (data.type === SETUP_NOTEBOOK && routeContext.appLoadingStatus === AppLoadingStatus.NOT_STARTED) {
            initialInlineSetupRef.current = handling;
        }
        void handling;
    });

    // Effect Events are non-reactive. Depending on consumeSetupEvent would resubscribe after every
    // render even though it always reads the latest callback state.
    React.useEffect(() => {
        appEvents.subscribeSetupEvents(handleSetupEvent);
        return () => appEvents.unsubscribeSetupEvents(handleSetupEvent);
    }, [appEvents]);

    // Effect to run the initial setup once at the beginning.
    // We guard against re-runs triggered by config identity changes (e.g. AppSettingsSync
    // hydrating persisted settings into AppConfig). The abort controller is only fired
    // on unmount so an in-flight setup is not cancelled by an unrelated config update.
    const hasStartedSetup = React.useRef(false);
    const setupAbortRef = React.useRef<AbortController | null>(null);
    React.useEffect(() => () => {
        setupAbortRef.current?.abort();
        remoteNotebookAbortRef.current?.abort();
    }, []);
    React.useEffect(() => {
        if (config == null || !appSettingsReady || hasStartedSetup.current) {
            return;
        }
        hasStartedSetup.current = true;
        const abort = new AbortController();
        setupAbortRef.current = abort;
        let failedComponent: string | null = null;
        const trackInitialization = async <T,>(name: string, promise: Promise<T>): Promise<T> => {
            try {
                return await promise;
            } catch (error) {
                failedComponent ??= name;
                throw error;
            }
        };

        const run = async () => {
            // Start trace for app loading
            const traced = logger.withTrace(createTrace());
            traced.info("Initializing application", {}, "app_loader");
            const totalStartTime = performance.now();

            // Wait for Core and the platform's embedded database to be ready.
            traced.info("Initializing Core and embedded database", {}, "app_loader");
            const coreStartTime = performance.now();

            const corePromise = trackInitialization("Core", setupCore("app_setup"));
            setEmbeddedDatabaseStatus(IndicatorStatus.Running);
            const embeddedDatabasePromise = trackInitialization(
                "HyperDB",
                setupEmbeddedDatabase("app_setup").then(database => {
                    setEmbeddedDatabaseStatus(IndicatorStatus.Succeeded);
                    return database;
                }).catch(error => {
                    setEmbeddedDatabaseStatus(IndicatorStatus.Failed);
                    throw error;
                }),
            );
            const fontsPromise = trackInitialization("Fonts", loadFonts());
            const [core] = await Promise.all([corePromise, embeddedDatabasePromise, fontsPromise]);

            const coreDuration = performance.now() - coreStartTime;
            traced.info("Core and embedded database ready", {
                durationMs: coreDuration.toFixed(2)
            }, "app_loader");

            // Load the app
            traced.info("Loading application state and notebooks", {}, "app_loader");
            const loaded = await trackInitialization(
                "Application state",
                loadApp(traced, core, storageReader, setConnReg, setNotebookScriptsRegistry, setLoadingProgress),
            );

            // Surface any notebooks that were refused a load in the selector. This is just an
            // aggregate count for the log — each refused notebook already logs a WARN with its path
            // and reason, so a second WARN here would only duplicate the diagnostic. Keep it at INFO.
            if (loaded.invalidNotebooks.size > 0) {
                traced.info("Some notebooks were refused a load", {
                    count: loaded.invalidNotebooks.size.toString()
                }, "app_loader");
                setInvalidNotebooks(loaded.invalidNotebooks);
            }

            const totalDuration = performance.now() - totalStartTime;
            traced.info("Application loaded successfully", {
                totalDurationMs: totalDuration.toFixed(2)
            }, "app_loader");

            // Mark the setup as done
            traced.info("Marking setup as done", {}, "app_loader");
            resolveSetupDone();

            traced.info("Finishing setup", {}, "app_loader");

            if (await shouldFinishInitialNavigation(initialInlineSetupRef.current)) {
                let notebookId = selectStartupNotebook(loaded.restoredNotebookIds);
                if (notebookId == null) {
                    notebookId = crypto.randomUUID();
                    const database = allocateAttachedDatabase(
                        notebookId,
                        { ...createDefaultHyperWasmAttachedDatabaseState(core, connReg.attachedDatabasesBySignature), active: true },
                    );
                    setupNotebookScripts(notebookId, database, 'Default');
                    void storageWriter.write(groupNotebookManifestWrites(notebookId), {
                        type: WRITE_NOTEBOOK_MANIFEST,
                        value: [notebookId, database.databaseId, [database]],
                    });
                }
                navigate({
                    type: OPEN_LINK_NOTEBOOK,
                    value: notebookId,
                });
            }
            globalThis.__DASHQL_STARTUP__ = {
                embeddedDatabase: 'hyperdb-wasm',
                host: getAppHost(),
                status: 'ready',
            };
        };
        run().catch(error => {
            globalThis.__DASHQL_STARTUP__ = {
                embeddedDatabase: null,
                error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
                host: getAppHost(),
                status: 'failed',
            };
            logger.error("Application initialization failed", {
                component: failedComponent ?? "Unknown",
            }, "app_loader");
        });
    }, [appSettingsReady, config]);

    // Delete an invalid notebook: remove its files from storage and drop it from the selector list.
    // Invalid notebooks never entered the connection/notebook registries, so there is nothing to
    // dispatch there — only the persisted files and our local list need cleaning up.
    const deleteInvalidNotebook = React.useCallback(async (notebookId: string) => {
        try {
            await storageWriter.backend.deleteNotebook(notebookId);
        } catch (e) {
            logger.error("Failed to delete invalid notebook", { notebookId, error: String(e) }, "app_loader");
        }
        setInvalidNotebooks(prev => {
            if (!prev.has(notebookId)) return prev;
            const next = new Map(prev);
            next.delete(notebookId);
            return next;
        });
    }, [storageWriter, logger]);
    const invalidNotebookRegistry = React.useMemo(
        () => ({ invalidNotebooks, deleteInvalidNotebook }),
        [invalidNotebooks, deleteInvalidNotebook],
    );

    if (showNarrowScreenWarning) {
        return <NarrowScreenWarning onEnable={() => reconfigure(value => value == null ? null : {
            ...value,
            settings: { ...value.settings, narrowScreenLayout: true },
        })} />;
    }

    if (remoteNotebookLoading != null) {
        return <NotebookImportCard
            phase="loading"
            sourceUrl={remoteNotebookLoading.sourceUrl}
            progress={remoteNotebookLoading.progress}
            onClose={cancelRemoteNotebookLoad}
        />;
    }
    if (loadedNotebook != null) {
        return <NotebookImportCard
            phase="ready"
            result={loadedNotebook}
            conflictLocation={loadedNotebookConflict?.displayLocation ?? null}
            conflictIsNative={getAppHost() === AppHost.ELECTRON && (loadedNotebookConflict?.isNative ?? false)}
            busy={loadedNotebookBusy}
            onImport={() => importLoadedNotebook()}
            onReplace={() => importLoadedNotebook('replace')}
            onCreateNew={() => importLoadedNotebook('create-new')}
            onClose={cancelLoadedNotebook}
        />;
    }

    // Setup done and notebook selected? Show main interface
    const pauseAfterSetup = config?.settings?.pauseAfterAppSetup ?? false;
    if (canShowNotebook(routeContext, pauseAfterSetup)) {
        return (
            <InvalidNotebookRegistryProvider value={invalidNotebookRegistry}>
                {props.children}
            </InvalidNotebookRegistryProvider>
        );
    } else {
        // Otherwise show the app loading page
        return <AppLoadingPage
            pauseAfterSetup={config?.settings?.pauseAfterAppSetup ?? false}
            progress={loadingProgress}
            embeddedDatabaseStatus={embeddedDatabaseStatus}
        />;
    }
};
