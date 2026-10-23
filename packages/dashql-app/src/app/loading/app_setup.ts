import * as React from 'react';

import { OPEN_LINK_SESSION, useRouterNavigate } from '../router/router.js';
import { useConnectionAllocator, useConnectionRegistrySetter } from '../connections/connection_registry.js';
import { isHyperWasmConnection } from '../connections/ui/connection_label.js';
import { useDashQLCoreSetup } from '../providers/core_provider.js';
import { useLogger } from '../../platform/logger/logger_provider.js';
import { createTrace } from '../../platform/logger/trace_context.js';
import { useSessionCreation } from '../session/session_creation.js';
import { AppLoadingProgress } from './app_loading_progress.js';
import { ProgressCounter } from '../../utils/progress.js';
import { loadApp, selectStartupSession, shouldFinishInitialNavigation } from './app_loading_logic.js';
import { useAppConfig } from '../config/app_config.js';
import { useStorage } from '../storage/storage_provider.js';
import { useSessionScriptsRegistrySetter } from '../session/scripts/session_scripts_registry.js';
import { useEmbeddedDatabaseSetup } from '../../platform/database/embedded_database_provider.js';
import { getAppHost } from '../../platform/native_globals.js';
import { restoreAppState } from '../session/persistence/app_state_loader.js';
import { IndicatorStatus } from '../../ui/foundations/status_indicator.js';
import { createDefaultHyperWasmConnectionState } from '../connections/connection_params.js';
import { useAppSettingsReady } from '../config/app_settings_sync.js';

const LOG_CTX = "app_loader";

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

/// The setup of the app
export interface AppSetup {
    /// Resolves once the app state is restored
    done: Promise<void>;
    /// The progress of the restoration
    progress: AppLoadingProgress;
    /// The status of the setup of the embedded database
    embeddedDatabaseStatus: IndicatorStatus;
}

/// Set up the app once its settings are ready.
///
/// The setup initializes the core, the embedded database and the fonts, restores the connections and
/// sessions and then opens the first session. A session that the app was started with is opened by
/// its import instead, `initialImport` resolves to true if it opened one.
export function useAppSetup(initialImport: React.RefObject<Promise<boolean> | null>): AppSetup {
    const config = useAppConfig();
    const appSettingsReady = useAppSettingsReady();
    const logger = useLogger();
    const navigate = useRouterNavigate();
    const setupCore = useDashQLCoreSetup();
    const createSession = useSessionCreation();
    const [storageReader] = useStorage();
    const allocateConnection = useConnectionAllocator();
    const setConnReg = useConnectionRegistrySetter();
    const setSessionScriptsRegistry = useSessionScriptsRegistrySetter();
    const setupEmbeddedDatabase = useEmbeddedDatabaseSetup();

    const [embeddedDatabaseStatus, setEmbeddedDatabaseStatus] = React.useState<IndicatorStatus>(IndicatorStatus.None);
    const [progress, setProgress] = React.useState<AppLoadingProgress>(() => ({
        restoreConnections: new ProgressCounter(),
        restoreCatalogs: new ProgressCounter(),
        restoreSessionScripts: new ProgressCounter(),
    }));
    const [done, resolveDone] = React.useMemo(() => {
        let resolve: () => void;
        const promise = new Promise<void>(a => { resolve = a; });
        return [promise, resolve!] as const;
    }, []);

    // Run the setup once at the beginning. We guard against re-runs triggered by config identity
    // changes (e.g. AppSettingsSync hydrating persisted settings into AppConfig).
    const hasStartedSetup = React.useRef(false);
    React.useEffect(() => {
        if (config == null || !appSettingsReady || hasStartedSetup.current) {
            return;
        }
        hasStartedSetup.current = true;
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
            traced.info("Initializing application", {}, LOG_CTX);
            const totalStartTime = performance.now();

            // Wait for Core and the platform's embedded database to be ready.
            traced.info("Initializing Core and embedded database", {}, LOG_CTX);
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
            }, LOG_CTX);

            // Load the app
            traced.info("Loading application state and sessions", {}, LOG_CTX);
            const loaded = await trackInitialization(
                "Application state",
                loadApp(traced, core, {
                    restoreAppState: (core, progressConsumer) => restoreAppState(core, storageReader.backend, logger, progressConsumer),
                }, setConnReg, setSessionScriptsRegistry, setProgress),
            );

            // The scripts registry lists the sessions that were refused a load. This is just an
            // aggregate count for the log — each refused session already logs a WARN with its path
            // and reason, so a second WARN here would only duplicate the diagnostic. Keep it at INFO.
            if (loaded.invalidSessions.size > 0) {
                traced.info("Some sessions were refused a load", {
                    count: loaded.invalidSessions.size.toString()
                }, LOG_CTX);
            }

            const totalDuration = performance.now() - totalStartTime;
            traced.info("Application loaded successfully", {
                totalDurationMs: totalDuration.toFixed(2)
            }, LOG_CTX);

            // Mark the setup as done
            traced.info("Marking setup as done", {}, LOG_CTX);
            resolveDone();

            traced.info("Finishing setup", {}, LOG_CTX);

            if (await shouldFinishInitialNavigation(initialImport.current)) {
                let sessionId = selectStartupSession(loaded.restoredSessionIds);
                if (sessionId == null) {
                    // The embedded engine is a single database, a known embedded connection is reused
                    const embedded = [...loaded.restoredConnections.values()].find(isHyperWasmConnection);
                    const database = embedded ?? allocateConnection({ ...createDefaultHyperWasmConnectionState(core), active: true });
                    sessionId = createSession(database, 'Default').sessionId;
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
            }, LOG_CTX);
        });
    }, [appSettingsReady, config]);

    return { done, progress, embeddedDatabaseStatus };
}
