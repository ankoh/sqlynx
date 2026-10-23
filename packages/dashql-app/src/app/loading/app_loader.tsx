import * as React from 'react';

import { AppLoadingStatus } from '../router/app_loading_status.js';
import { OPEN_LINK_SESSION, SELECT_SESSION, useRouteContext, useRouterNavigate } from '../router/router.js';
import { resolveSessionExecutionDatabase, useAttachConnection, useConnectionDispatch, useConnectionRegistry, useAttachedDatabaseStateAllocator, sessionConnectionFromState } from '../connections/connection_registry.js';
import { isHyperWasmConnection } from '../connections/ui/connection_label.js';
import { useDashQLCoreSetup } from '../providers/core_provider.js';
import { useLogger } from '../../platform/logger/logger_provider.js';
import { createTrace } from '../../platform/logger/trace_context.js';
import { usePlatformEventListener } from '../../platform/events/event_listener_provider.js';
import { useSessionScriptsSetup } from '../session/scripts/session_scripts_setup.js';
import { AppLoadingPage } from '../ui/app_loading_page.js';
import { SETUP_SESSION, SETUP_SESSION_URL, SetupEventVariant } from '../../platform/events/event.js';
import { AppLoadingProgress } from './app_loading_progress.js';
import { ProgressCounter } from '../../utils/progress.js';
import { canShowSession, loadApp, selectStartupSession, shouldFinishInitialNavigation } from './app_loading_logic.js';
import { useAppConfig, useAppReconfigure } from '../config/app_config.js';
import { useStorage } from '../storage/storage_provider.js';
import { groupSessionManifestWrites, WRITE_SESSION_MANIFEST } from '../storage/storage_writer.js';
import { useSessionScriptsRegistrySetter } from '../session/scripts/session_scripts_registry.js';
import { useEmbeddedDatabaseSetup } from '../../platform/database/embedded_database_provider.js';
import { InvalidSession } from '../storage/session_validation.js';
import { AppHost, getAppHost } from '../../platform/native_globals.js';
import { readSessionBundleFromZip } from '../session/persistence/session_import.js';
import { useSessionImport } from '../session/persistence/session_import_provider.js';
import { restoreAppState } from '../session/persistence/app_state_loader.js';
import { useHttpClient } from '../../platform/http/http_client_provider.js';
import {
    readSessionBundleFromHttp,
    type HttpSessionLoadProgress,
    type HttpSessionLoadResult,
} from '../session/persistence/http_session_bundle.js';
import { stringifyError } from '../../platform/logger/logger.js';
import { SessionImportCard } from '../session/ui/session_import_card.js';
import { IndicatorStatus } from '../../ui/foundations/status_indicator.js';
import { createDefaultHyperWasmConnectionState } from '../connections/connection_params.js';
import { useAppSettingsReady } from '../config/app_settings_sync.js';
import { InvalidSessionRegistryProvider } from '../session/persistence/invalid_session_registry.js';
import { useHyperSetup } from '../connections/hyper/hyper_connection_setup.js';
import { useInitialMemorySetup } from './initial_memory_setup.js';
import { SessionSetupStatus } from '../router/session_setup_status.js';
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
    const setupSessionScripts = useSessionScriptsSetup();
    const [storageReader, storageWriter] = useStorage();
    const allocateAttachedDatabase = useAttachedDatabaseStateAllocator();
    const attachConnection = useAttachConnection();
    const [connReg, setConnReg] = useConnectionRegistry();
    const dispatchDatabase = useConnectionDispatch();
    const setSessionScriptsRegistry = useSessionScriptsRegistrySetter();
    const setupEmbeddedDatabase = useEmbeddedDatabaseSetup();
    const hyperSetup = useHyperSetup();

    const appEvents = usePlatformEventListener();
    const sessionImport = useSessionImport();
    const httpClient = useHttpClient();
    const [embeddedDatabaseStatus, setEmbeddedDatabaseStatus] = React.useState<IndicatorStatus>(IndicatorStatus.None);
    const [loadedSession, setLoadedSession] = React.useState<HttpSessionLoadResult | null>(null);
    const [loadedSessionConflict, setLoadedSessionConflict] = React.useState<{
        displayLocation: string;
        isNative: boolean;
    } | null>(null);
    const [loadedSessionBusy, setLoadedSessionBusy] = React.useState(false);
    const [remoteSessionLoading, setRemoteSessionLoading] = React.useState<{
        sourceUrl: string;
        progress: HttpSessionLoadProgress;
    } | null>(null);
    const remoteSessionAbortRef = React.useRef<AbortController | null>(null);
    // Normal startup must not replace the route selected by an inline session import.
    const initialInlineSetupRef = React.useRef<Promise<boolean> | null>(null);
    // Sessions whose metadata was refused a load. Surfaced (marked invalid, blocked, deletable) in
    // the session workbench instead of being silently dropped.
    const [invalidSessions, setInvalidSessions] = React.useState<Map<string, InvalidSession>>(() => new Map());
    const [loadingProgress, setLoadingProgress] = React.useState<AppLoadingProgress>(() => ({
        restoreConnections: new ProgressCounter(),
        restoreCatalogs: new ProgressCounter(),
        restoreSessionScripts: new ProgressCounter(),
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
        if (routeContext.sessionSetupStatus === SessionSetupStatus.OPENING && routeContext.sessionId != null) {
            navigate({ type: SELECT_SESSION, value: routeContext.sessionId });
        }
    }, [navigate, routeContext.sessionId, routeContext.sessionSetupStatus]);

    useInitialMemorySetup(
        routeContext.sessionId,
        routeContext.sessionId == null ? null : resolveSessionExecutionDatabase(connReg, routeContext.sessionId),
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
        let remoteLoad: Promise<HttpSessionLoadResult> | null = null;
        if (data.type === SETUP_SESSION_URL) {
            remoteSessionAbortRef.current?.abort();
            remoteAbort = new AbortController();
            remoteSessionAbortRef.current = remoteAbort;
            setRemoteSessionLoading({ sourceUrl: data.value, progress: { phase: 'preparing' } });
            setLoadedSession(null);
            setLoadedSessionConflict(null);
            traced.info('Loading shared session', { sourceUrl: data.value }, 'app_loader');
            remoteLoad = readSessionBundleFromHttp(
                new URL(data.value),
                httpClient,
                remoteAbort.signal,
                progress => {
                    if (remoteSessionAbortRef.current === remoteAbort) {
                        setRemoteSessionLoading({ sourceUrl: data.value, progress });
                    }
                },
            );
        }

        // Remote session I/O can proceed while the application initializes. Import and conflict
        // detection still wait for setup because they use the initialized storage registry.
        const setup = Promise.all([setupCore("app_setup"), setupDone]);
        const remoteResult = remoteLoad == null ? null : await remoteLoad;
        await setup;
        remoteAbort?.signal.throwIfAborted();
        if (data.type === SETUP_SESSION) {
            const zipBlob = new Blob([data.value.buffer as ArrayBuffer], { type: 'application/zip' });
            const bundle = await readSessionBundleFromZip(zipBlob);
            const sessionId = await sessionImport.importPortableBundle(bundle, {
                presentation: { mode: 'centered' },
            });
            if (sessionId != null) {
                traced.debug("Finished link setup", { sessionId }, "app_loader");
                navigate({ type: OPEN_LINK_SESSION, value: sessionId });
                return true;
            }
        } else if (data.type === SETUP_SESSION_URL) {
            const result = remoteResult!;
            if (remoteSessionAbortRef.current === remoteAbort) {
                traced.info('Loaded shared session', {
                    sessionId: result.bundle.session.sessionId,
                    loadedScriptCount: String(result.loadedScriptCount),
                    listedScriptCount: String(result.listedScriptCount),
                    incomplete: String(result.incomplete),
                }, 'app_loader');
                const conflictLocation = await sessionImport.findPortableBundleConflict(result.bundle);
                remoteAbort!.signal.throwIfAborted();
                if (remoteSessionAbortRef.current !== remoteAbort) return false;
                traced.info('Checked shared session import conflict', {
                    sessionId: result.bundle.session.sessionId,
                    conflict: String(conflictLocation != null),
                    existingLocation: conflictLocation?.displayLocation ?? '',
                }, 'app_loader');
                remoteSessionAbortRef.current = null;
                setRemoteSessionLoading(null);
                setLoadedSessionConflict(conflictLocation);
                setLoadedSession(result);
            }
            return false;
        }
        return false;
    });

    const cancelRemoteSessionLoad = React.useCallback(() => {
        remoteSessionAbortRef.current?.abort();
        remoteSessionAbortRef.current = null;
        setRemoteSessionLoading(null);
    }, []);

    const importLoadedSession = React.useCallback((choice?: 'replace' | 'create-new') => {
        if (loadedSession == null || loadedSessionBusy) return;
        setLoadedSessionBusy(true);
        const result = loadedSession;
        const importChoice = choice ?? 'import';
        logger.info('Importing shared session', {
            sessionId: result.bundle.session.sessionId,
            choice: importChoice,
        }, 'app_loader');
        const importPromise = choice == null
            ? sessionImport.importPortableBundleWithChoice(result.bundle, 'create-new')
            : sessionImport.importPortableBundleWithChoice(result.bundle, choice);
        void importPromise.then(sessionId => {
            // The user cancelled the import while choosing connections
            if (sessionId == null) return;
            logger.info('Imported shared session', {
                sourceSessionId: result.bundle.session.sessionId,
                sessionId,
                choice: importChoice,
            }, 'app_loader');
            setLoadedSession(null);
            setLoadedSessionConflict(null);
            navigate({ type: OPEN_LINK_SESSION, value: sessionId });
        }).catch(error => {
            logger.error('Failed to import loaded session', { error: stringifyError(error) }, 'app_loader');
        }).finally(() => setLoadedSessionBusy(false));
    }, [loadedSession, loadedSessionBusy, logger, navigate, sessionImport]);

    const cancelLoadedSession = React.useCallback(() => {
        if (loadedSessionBusy) return;
        setLoadedSession(null);
        setLoadedSessionConflict(null);
    }, [loadedSessionBusy]);

    const handleSetupEvent = React.useEffectEvent((data: SetupEventVariant) => {
        const handling = consumeSetupEvent(data).catch(error => {
            if ((error as Error)?.name === 'AbortError') return false;
            remoteSessionAbortRef.current = null;
            setRemoteSessionLoading(null);
            logger.error('Failed to open shared session', { error: stringifyError(error) }, 'app_loader');
            return false;
        });
        if (data.type === SETUP_SESSION && routeContext.appLoadingStatus === AppLoadingStatus.NOT_STARTED) {
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
        remoteSessionAbortRef.current?.abort();
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
            traced.info("Loading application state and sessions", {}, "app_loader");
            const loaded = await trackInitialization(
                "Application state",
                loadApp(traced, core, {
                    restoreAppState: (core, progressConsumer) => restoreAppState(core, storageReader.backend, logger, progressConsumer),
                }, setConnReg, setSessionScriptsRegistry, setLoadingProgress),
            );

            // Surface any sessions that were refused a load in the selector. This is just an
            // aggregate count for the log — each refused session already logs a WARN with its path
            // and reason, so a second WARN here would only duplicate the diagnostic. Keep it at INFO.
            if (loaded.invalidSessions.size > 0) {
                traced.info("Some sessions were refused a load", {
                    count: loaded.invalidSessions.size.toString()
                }, "app_loader");
                setInvalidSessions(loaded.invalidSessions);
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
                let sessionId = selectStartupSession(loaded.restoredSessionIds);
                if (sessionId == null) {
                    sessionId = crypto.randomUUID();
                    // The embedded engine is a single database, a known embedded connection is reused
                    const embedded = [...loaded.restoredConnections.values()].find(isHyperWasmConnection);
                    if (embedded != null) attachConnection(sessionId, embedded.connectionId);
                    const database = embedded ?? allocateAttachedDatabase(
                        sessionId,
                        { ...createDefaultHyperWasmConnectionState(core), active: true },
                    );
                    setupSessionScripts(sessionId, database, 'Default');
                    void storageWriter.write(groupSessionManifestWrites(sessionId), {
                        type: WRITE_SESSION_MANIFEST,
                        value: [sessionId, database.connectionId, [sessionConnectionFromState(database)]],
                    });
                }
                navigate({
                    type: OPEN_LINK_SESSION,
                    value: sessionId,
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

    // Delete an invalid session: remove its files from storage and drop it from the selector list.
    // Invalid sessions never entered the connection/session registries, so there is nothing to
    // dispatch there — only the persisted files and our local list need cleaning up.
    const deleteInvalidSession = React.useCallback(async (sessionId: string) => {
        try {
            await storageWriter.backend.deleteSession(sessionId);
        } catch (e) {
            logger.error("Failed to delete invalid session", { sessionId, error: String(e) }, "app_loader");
        }
        setInvalidSessions(prev => {
            if (!prev.has(sessionId)) return prev;
            const next = new Map(prev);
            next.delete(sessionId);
            return next;
        });
    }, [storageWriter, logger]);
    const invalidSessionRegistry = React.useMemo(
        () => ({ invalidSessions, deleteInvalidSession }),
        [invalidSessions, deleteInvalidSession],
    );

    if (showNarrowScreenWarning) {
        return <NarrowScreenWarning onEnable={() => reconfigure(value => value == null ? null : {
            ...value,
            settings: { ...value.settings, narrowScreenLayout: true },
        })} />;
    }

    if (remoteSessionLoading != null) {
        return <SessionImportCard
            phase="loading"
            sourceUrl={remoteSessionLoading.sourceUrl}
            progress={remoteSessionLoading.progress}
            onClose={cancelRemoteSessionLoad}
        />;
    }
    if (loadedSession != null) {
        return <SessionImportCard
            phase="ready"
            result={loadedSession}
            conflictLocation={loadedSessionConflict?.displayLocation ?? null}
            conflictIsNative={getAppHost() === AppHost.ELECTRON && (loadedSessionConflict?.isNative ?? false)}
            busy={loadedSessionBusy}
            onImport={() => importLoadedSession()}
            onReplace={() => importLoadedSession('replace')}
            onCreateNew={() => importLoadedSession('create-new')}
            onClose={cancelLoadedSession}
        />;
    }

    // Setup done and session selected? Show main interface
    const pauseAfterSetup = config?.settings?.pauseAfterAppSetup ?? false;
    if (canShowSession(routeContext, pauseAfterSetup)) {
        return (
            <InvalidSessionRegistryProvider value={invalidSessionRegistry}>
                {props.children}
            </InvalidSessionRegistryProvider>
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
