import * as React from 'react';

import { AppLoadingStatus } from './app_loading_status.js';
import { OPEN_LINK_SESSION, useRouteContext, useRouterNavigate } from '../router/router.js';
import { useDashQLCoreSetup } from '../providers/core_provider.js';
import { useLogger } from '../../platform/logger/logger_provider.js';
import { createTrace } from '../../platform/logger/trace_context.js';
import { stringifyError } from '../../platform/logger/logger.js';
import { usePlatformEventListener } from '../../platform/events/event_listener_provider.js';
import { SETUP_SESSION, SETUP_SESSION_URL, SetupEventVariant } from '../../platform/events/event.js';
import { AppHost, getAppHost } from '../../platform/native_globals.js';
import { useHttpClient } from '../../platform/http/http_client_provider.js';
import { readSessionBundleFromZip } from '../session/persistence/session_import.js';
import { useSessionImport } from '../session/persistence/session_import_provider.js';
import {
    readSessionBundleFromHttp,
    type HttpSessionLoadProgress,
    type HttpSessionLoadResult,
} from '../session/persistence/http_session_bundle.js';
import { SessionImportCard } from '../session/ui/session_import_card.js';

const LOG_CTX = "app_loader";

/// A shared session that loads from its URL
interface RemoteSessionLoad {
    /// The URL of the session
    sourceUrl: string;
    /// The progress of the load
    progress: HttpSessionLoadProgress;
}

/// A loaded shared session that waits for the user to import it
interface LoadedSharedSession {
    /// The loaded session
    result: HttpSessionLoadResult;
    /// The registered session with the same id, if any
    conflict: { displayLocation: string; isNative: boolean } | null;
}

/// Import the sessions that the platform hands to the app.
///
/// A deep link or an opened `.dashql` file carries the session itself, it is imported right away. A
/// shared URL is loaded while the app sets up and then shown in a card until the user imports it.
/// Imports wait for `setupDone` since they use the restored registries. The import of a session that
/// the app was started with is stored in `initialImport`, the setup doesn't open another session
/// when it opens one.
///
/// Returns the card of a shared session, null if there is none.
export function useSharedSessionImport(
    setupDone: Promise<void>,
    initialImport: React.RefObject<Promise<boolean> | null>,
): React.ReactElement | null {
    const logger = useLogger();
    const navigate = useRouterNavigate();
    const routeContext = useRouteContext();
    const setupCore = useDashQLCoreSetup();
    const appEvents = usePlatformEventListener();
    const sessionImport = useSessionImport();
    const httpClient = useHttpClient();

    const [remoteLoad, setRemoteLoad] = React.useState<RemoteSessionLoad | null>(null);
    const [loaded, setLoaded] = React.useState<LoadedSharedSession | null>(null);
    const [importBusy, setImportBusy] = React.useState(false);
    const remoteAbortRef = React.useRef<AbortController | null>(null);
    React.useEffect(() => () => remoteAbortRef.current?.abort(), []);

    // Returns true if the event opened a session
    const consumeSetupEvent = React.useEffectEvent(async (data: SetupEventVariant): Promise<boolean> => {
        // Start trace for setup event handling
        const traced = logger.withTrace(createTrace());
        traced.debug("Consuming setup event", { "event_type": String(data.type) }, LOG_CTX);

        let remoteAbort: AbortController | null = null;
        let remoteResult: Promise<HttpSessionLoadResult> | null = null;
        if (data.type === SETUP_SESSION_URL) {
            remoteAbortRef.current?.abort();
            remoteAbort = new AbortController();
            remoteAbortRef.current = remoteAbort;
            setRemoteLoad({ sourceUrl: data.value, progress: { phase: 'preparing' } });
            setLoaded(null);
            traced.info('Loading shared session', { sourceUrl: data.value }, LOG_CTX);
            remoteResult = readSessionBundleFromHttp(
                new URL(data.value),
                httpClient,
                remoteAbort.signal,
                progress => {
                    if (remoteAbortRef.current === remoteAbort) {
                        setRemoteLoad({ sourceUrl: data.value, progress });
                    }
                },
            );
        }

        // Remote session I/O can proceed while the application initializes. Import and conflict
        // detection still wait for setup because they use the initialized storage registry.
        const setup = Promise.all([setupCore("app_setup"), setupDone]);
        const result = remoteResult == null ? null : await remoteResult;
        await setup;
        remoteAbort?.signal.throwIfAborted();
        if (data.type === SETUP_SESSION) {
            const zipBlob = new Blob([data.value.buffer as ArrayBuffer], { type: 'application/zip' });
            const bundle = await readSessionBundleFromZip(zipBlob);
            const sessionId = await sessionImport.importPortableBundle(bundle, {
                presentation: { mode: 'centered' },
            });
            if (sessionId != null) {
                traced.debug("Finished link setup", { sessionId }, LOG_CTX);
                navigate({ type: OPEN_LINK_SESSION, value: sessionId });
                return true;
            }
        } else if (data.type === SETUP_SESSION_URL && remoteAbortRef.current === remoteAbort) {
            traced.info('Loaded shared session', {
                sessionId: result!.bundle.session.sessionId,
                loadedScriptCount: String(result!.loadedScriptCount),
                listedScriptCount: String(result!.listedScriptCount),
                incomplete: String(result!.incomplete),
            }, LOG_CTX);
            const conflict = await sessionImport.findPortableBundleConflict(result!.bundle);
            remoteAbort!.signal.throwIfAborted();
            if (remoteAbortRef.current !== remoteAbort) return false;
            traced.info('Checked shared session import conflict', {
                sessionId: result!.bundle.session.sessionId,
                conflict: String(conflict != null),
                existingLocation: conflict?.displayLocation ?? '',
            }, LOG_CTX);
            remoteAbortRef.current = null;
            setRemoteLoad(null);
            setLoaded({ result: result!, conflict });
        }
        return false;
    });

    const handleSetupEvent = React.useEffectEvent((data: SetupEventVariant) => {
        const handling = consumeSetupEvent(data).catch(error => {
            if ((error as Error)?.name === 'AbortError') return false;
            remoteAbortRef.current = null;
            setRemoteLoad(null);
            logger.error('Failed to open shared session', { error: stringifyError(error) }, LOG_CTX);
            return false;
        });
        // Normal startup must not replace the route selected by an inline session import
        if (data.type === SETUP_SESSION && routeContext.appLoadingStatus === AppLoadingStatus.NOT_STARTED) {
            initialImport.current = handling;
        }
        void handling;
    });

    // Effect Events are non-reactive. Depending on handleSetupEvent would resubscribe after every
    // render even though it always reads the latest callback state.
    React.useEffect(() => {
        appEvents.subscribeSetupEvents(handleSetupEvent);
        return () => appEvents.unsubscribeSetupEvents(handleSetupEvent);
    }, [appEvents]);

    const cancelRemoteLoad = React.useCallback(() => {
        remoteAbortRef.current?.abort();
        remoteAbortRef.current = null;
        setRemoteLoad(null);
    }, []);

    const importLoaded = React.useCallback((choice?: 'replace' | 'create-new') => {
        if (loaded == null || importBusy) return;
        setImportBusy(true);
        const { result } = loaded;
        const importChoice = choice ?? 'import';
        logger.info('Importing shared session', {
            sessionId: result.bundle.session.sessionId,
            choice: importChoice,
        }, LOG_CTX);
        void sessionImport.importPortableBundleWithChoice(result.bundle, choice ?? 'create-new').then(sessionId => {
            // The user cancelled the import while choosing connections
            if (sessionId == null) return;
            logger.info('Imported shared session', {
                sourceSessionId: result.bundle.session.sessionId,
                sessionId,
                choice: importChoice,
            }, LOG_CTX);
            setLoaded(null);
            navigate({ type: OPEN_LINK_SESSION, value: sessionId });
        }).catch(error => {
            logger.error('Failed to import loaded session', { error: stringifyError(error) }, LOG_CTX);
        }).finally(() => setImportBusy(false));
    }, [loaded, importBusy, logger, navigate, sessionImport]);

    const cancelLoaded = React.useCallback(() => {
        if (importBusy) return;
        setLoaded(null);
    }, [importBusy]);

    if (remoteLoad != null) {
        return <SessionImportCard
            phase="loading"
            sourceUrl={remoteLoad.sourceUrl}
            progress={remoteLoad.progress}
            onClose={cancelRemoteLoad}
        />;
    }
    if (loaded != null) {
        return <SessionImportCard
            phase="ready"
            result={loaded.result}
            conflictLocation={loaded.conflict?.displayLocation ?? null}
            conflictIsNative={getAppHost() === AppHost.ELECTRON && (loaded.conflict?.isNative ?? false)}
            busy={importBusy}
            onImport={() => importLoaded()}
            onReplace={() => importLoaded('replace')}
            onCreateNew={() => importLoaded('create-new')}
            onClose={cancelLoaded}
        />;
    }
    return null;
}
