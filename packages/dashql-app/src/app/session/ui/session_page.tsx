import * as React from 'react';
import * as styles from './session_page.module.css';

import { useSessionScripts } from '../scripts/session_scripts_registry.js';
import { useConnectionRegistry, useConnectionState } from '../../connections/connection_registry.js';
import type { ConnectionState } from '../../connections/connection_state.js';
import { sessionConnectionIds } from '../scripts/session_scripts.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import { useRouteContext } from '../../router/router.js';

import { SessionFeedPage } from './feed/session_feed_page.js';
import { SessionViewMode, useSessionViewMode } from '../scripts/session_commands.js';

const SessionShellPage = React.lazy(() => import('../shell/session_shell_page.js'));

const LOG_CTX = 'session_page';

export interface SessionPageDependencies {
    useSessionScripts: typeof useSessionScripts;
    useConnectionState: typeof useConnectionState;
    useConnectionRegistry: typeof useConnectionRegistry;
    useLogger: typeof useLogger;
    useRouteContext: typeof useRouteContext;
    useSessionViewMode: typeof useSessionViewMode;
    SessionFeedPage: typeof SessionFeedPage;
    SessionShellPage: typeof SessionShellPage;
}

const DEFAULT_DEPENDENCIES: SessionPageDependencies = {
    useSessionScripts,
    useConnectionState,
    useConnectionRegistry,
    useLogger,
    useRouteContext,
    useSessionViewMode,
    SessionFeedPage,
    SessionShellPage,
};

interface Props {
    dependencies?: SessionPageDependencies;
}

export const SessionPage: React.FC<Props> = (props: Props) => {
    const dependencies = props.dependencies ?? DEFAULT_DEPENDENCIES;
    const route = dependencies.useRouteContext();
    const logger = dependencies.useLogger();
    const [sessionScripts, modifySessionScripts] = dependencies.useSessionScripts(route.sessionId ?? null);
    const [conn] = dependencies.useConnectionState(sessionScripts?.sessionId ?? null);
    // The connections that the scripts of the session run on
    const [connectionRegistry] = dependencies.useConnectionRegistry();
    const scriptConnections = new Map<string, ConnectionState>();
    for (const connectionId of sessionScripts == null ? [] : sessionConnectionIds(sessionScripts)) {
        const connection = connectionRegistry.connections.get(connectionId);
        if (connection != null) scriptConnections.set(connectionId, connection);
    }
    const { mode: sessionMode } = dependencies.useSessionViewMode();
    const sessionPageVisible = sessionMode !== SessionViewMode.Shell;

    React.useEffect(() => {
        if (route.sessionId === null) {
            logger.warn('missing session id', {}, LOG_CTX);
        }
    }, [route.sessionId]);

    if (route.sessionId === null || sessionScripts == null) {
        return <div />;
    }
    return (
        <div className={styles.page}>
            <div className={sessionPageVisible ? styles.view : styles.view_hidden}>
                <dependencies.SessionFeedPage
                    sessionScripts={sessionScripts}
                    modifySessionScripts={modifySessionScripts}
                    connection={conn ?? null}
                    scriptConnections={scriptConnections}
                    active={sessionMode === SessionViewMode.Session}
                />
            </div>
            {sessionMode === SessionViewMode.Shell && (
                <div className={styles.view}>
                    <React.Suspense fallback={(
                        <div className={styles.shellLoading} role="status">
                            <strong>[ RUN ]</strong> Loading shell
                        </div>
                    )}>
                        <dependencies.SessionShellPage sessionId={sessionScripts.sessionId} sessionName={sessionScripts.name} connection={conn ?? null} active />
                    </React.Suspense>
                </div>
            )}
        </div>
    );
};
