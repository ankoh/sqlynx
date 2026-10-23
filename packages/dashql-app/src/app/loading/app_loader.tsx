import * as React from 'react';

import { SELECT_SESSION, useRouteContext, useRouterNavigate } from '../router/router.js';
import { useConnectionDispatch, useDefaultConnection } from '../connections/connection_registry.js';
import { useLogger } from '../../platform/logger/logger_provider.js';
import { AppLoadingPage } from '../ui/app_loading_page.js';
import { canShowSession } from './app_loading_logic.js';
import { useAppConfig, useAppReconfigure } from '../config/app_config.js';
import { useAppSettingsReady } from '../config/app_settings_sync.js';
import { useHyperSetup } from '../connections/hyper/hyper_connection_setup.js';
import { useInitialMemorySetup } from './initial_memory_setup.js';
import { SessionSetupStatus } from './session_setup_status.js';
import { NarrowScreenWarning, useNarrowScreenWarning } from '../ui/narrow_screen_warning.js';
import { useAppSetup } from './app_setup.js';
import { useSharedSessionImport } from './shared_session_import.js';

interface Props { }

export const AppLoader: React.FC<React.PropsWithChildren<Props>> = (props: React.PropsWithChildren<Props>) => {
    const config = useAppConfig();
    const appSettingsReady = useAppSettingsReady();
    const reconfigure = useAppReconfigure();
    const showNarrowScreenWarning = useNarrowScreenWarning(appSettingsReady, config?.settings?.narrowScreenLayout ?? false);
    const logger = useLogger();
    const navigate = useRouterNavigate();
    const routeContext = useRouteContext();
    const [defaultConnection] = useDefaultConnection(routeContext.sessionId ?? null);
    const dispatchDatabase = useConnectionDispatch();
    const hyperSetup = useHyperSetup();

    // The import of a session that the app was started with, the setup then doesn't open another one
    const initialImport = React.useRef<Promise<boolean> | null>(null);
    const setup = useAppSetup(initialImport);
    const sharedSessionCard = useSharedSessionImport(setup.done, initialImport);

    React.useEffect(() => {
        if (routeContext.sessionSetupStatus === SessionSetupStatus.OPENING && routeContext.sessionId != null) {
            navigate({ type: SELECT_SESSION, value: routeContext.sessionId });
        }
    }, [navigate, routeContext.sessionId, routeContext.sessionSetupStatus]);

    useInitialMemorySetup(
        routeContext.sessionId,
        defaultConnection,
        hyperSetup,
        dispatchDatabase,
        logger,
    );

    if (showNarrowScreenWarning) {
        return <NarrowScreenWarning onEnable={() => reconfigure(value => value == null ? null : {
            ...value,
            settings: { ...value.settings, narrowScreenLayout: true },
        })} />;
    }
    if (sharedSessionCard != null) {
        return sharedSessionCard;
    }

    // Setup done and session selected? Show main interface
    const pauseAfterSetup = config?.settings?.pauseAfterAppSetup ?? false;
    if (canShowSession(routeContext, pauseAfterSetup)) {
        return props.children;
    } else {
        // Otherwise show the app loading page
        return <AppLoadingPage
            pauseAfterSetup={pauseAfterSetup}
            progress={setup.progress}
            embeddedDatabaseStatus={setup.embeddedDatabaseStatus}
        />;
    }
};
