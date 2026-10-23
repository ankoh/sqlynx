import * as React from 'react';

import { useLocation, useNavigate } from 'react-router-dom';
import { useAppConfig } from '../../config/app_config.js';
import { useAppSettingsReady } from '../../config/app_settings_sync.js';

/// How a session is shown
export enum SessionViewMode {
    Session = 0,
    Shell = 1,
    Dashboard = 2,
}

export interface SessionViewModeContextValue {
    mode: SessionViewMode;
    setMode: React.Dispatch<React.SetStateAction<SessionViewMode>>;
}
const SESSION_VIEW_MODE_CTX = React.createContext<SessionViewModeContextValue | null>(null);
export const useSessionViewMode = () => React.useContext(SESSION_VIEW_MODE_CTX)!;

export function sessionViewModeFromSearch(search: string, dashboardsEnabled: boolean): SessionViewMode {
    return dashboardsEnabled && new URLSearchParams(search).get('view') === 'dashboard'
        ? SessionViewMode.Dashboard
        : SessionViewMode.Session;
}

export function sessionViewSearch(search: string, mode: SessionViewMode): string {
    const params = new URLSearchParams(search);
    if (mode === SessionViewMode.Dashboard) params.set('view', 'dashboard');
    else params.delete('view');
    const next = params.toString();
    return next ? `?${next}` : '';
}

export function sessionViewNavigation(
    location: { pathname: string; search: string; hash: string; state: unknown },
    mode: SessionViewMode,
) {
    return {
        to: {
            pathname: location.pathname,
            search: sessionViewSearch(location.search, mode),
            hash: location.hash,
        },
        options: { replace: true as const, state: location.state },
    };
}

/// The view mode of the session. The dashboard view is part of the URL and only exists while
/// dashboards are enabled in the settings.
export const SessionViewModeProvider: React.FC<React.PropsWithChildren> = (props: React.PropsWithChildren) => {
    const location = useLocation();
    const navigate = useNavigate();
    const dashboardsEnabled = useAppConfig()?.settings?.experimental_dashboards === true;
    const settingsReady = useAppSettingsReady();

    const [sessionViewMode, setSessionViewModeState] = React.useState(() => sessionViewModeFromSearch(location.search, dashboardsEnabled));
    const visibleViewMode = !dashboardsEnabled && sessionViewMode === SessionViewMode.Dashboard
        ? SessionViewMode.Session : sessionViewMode;
    const sessionViewModeRef = React.useRef(visibleViewMode);
    const pendingViewSearchRef = React.useRef<string | null>(null);
    sessionViewModeRef.current = visibleViewMode;
    const setSessionViewMode = React.useCallback<React.Dispatch<React.SetStateAction<SessionViewMode>>>((update) => {
        const next = typeof update === 'function' ? update(sessionViewModeRef.current) : update;
        const allowed = next === SessionViewMode.Dashboard && !dashboardsEnabled ? SessionViewMode.Session : next;
        sessionViewModeRef.current = allowed;
        setSessionViewModeState(allowed);
        const navigation = sessionViewNavigation(location, allowed);
        if (navigation.to.search !== location.search) {
            pendingViewSearchRef.current = navigation.to.search;
            navigate(navigation.to, navigation.options);
        }
    }, [dashboardsEnabled, location.pathname, location.search, location.hash, location.state, navigate]);
    const sessionViewModeValue = React.useMemo<SessionViewModeContextValue>(
        () => ({ mode: visibleViewMode, setMode: setSessionViewMode }),
        [visibleViewMode, setSessionViewMode],
    );

    React.useEffect(() => {
        if (!settingsReady) return;
        if (!dashboardsEnabled) {
            pendingViewSearchRef.current = null;
            if (sessionViewMode === SessionViewMode.Dashboard) {
                sessionViewModeRef.current = SessionViewMode.Session;
                setSessionViewModeState(SessionViewMode.Session);
            }
            if (new URLSearchParams(location.search).get('view') === 'dashboard') {
                const navigation = sessionViewNavigation(location, SessionViewMode.Session);
                navigate(navigation.to, navigation.options);
            }
            return;
        }
        if (pendingViewSearchRef.current != null) {
            if (pendingViewSearchRef.current === location.search) pendingViewSearchRef.current = null;
            return;
        }
        const requested = sessionViewModeFromSearch(location.search, dashboardsEnabled);
        if (requested === SessionViewMode.Dashboard && sessionViewModeRef.current !== requested) {
            sessionViewModeRef.current = requested;
            setSessionViewModeState(requested);
        } else if (requested !== SessionViewMode.Dashboard && sessionViewModeRef.current === SessionViewMode.Dashboard) {
            sessionViewModeRef.current = SessionViewMode.Session;
            setSessionViewModeState(SessionViewMode.Session);
        }
    }, [dashboardsEnabled, settingsReady, location.search, navigate]);

    return (
        <SESSION_VIEW_MODE_CTX.Provider value={sessionViewModeValue}>
            {props.children}
        </SESSION_VIEW_MODE_CTX.Provider>
    );
};
