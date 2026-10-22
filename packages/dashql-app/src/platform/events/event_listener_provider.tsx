import * as React from 'react';

import { useLocation } from 'react-router-dom';

import { PlatformEventListener, EVENT_QUERY_PARAMETER, SESSION_QUERY_PARAMETER, readSessionUrlParameter } from './event_listener.js';
import { LEGACY_SESSION_QUERY_PARAMETER } from '../../migration/legacy_links.js';
import { WebPlatformEventListener } from './web_event_listener.js';
import { ElectronPlatformEventListener } from './electron_event_listener.js';
import { AppHost, getAppHost } from '../native_globals.js';
import { useLogger } from '../logger/logger_provider.js';

export const SKIP_EVENT_LISTENER = Symbol("SKIP_EVENT_LISTENER");

const LISTENER_CTX = React.createContext<PlatformEventListener | null>(null);
export const usePlatformEventListener = () => React.useContext(LISTENER_CTX)!;

type Props = {
    children: React.ReactElement;
};

export const PlatformEventListenerProvider: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const location = useLocation();
    // HashRouter excludes the outer document query from its location. Setup links belong to the
    // document URL, so read them from window.location in both browser and packaged-app modes.
    const documentSearch = globalThis.location.search;

    // Construct the event listener
    const listener = React.useMemo<PlatformEventListener>(() => {
        const host = getAppHost();
        const l = host === AppHost.ELECTRON
            ? new ElectronPlatformEventListener(logger)
            : new WebPlatformEventListener(logger);
        return l;
    }, []);

    React.useEffect(() => {
        void listener.setup();
        return () => listener.dispose();
    }, [listener]);

    // Search for app events passed via the url parameter
    React.useEffect(() => {
        const searchParams = new URLSearchParams(documentSearch);
        const data = searchParams.get(EVENT_QUERY_PARAMETER);
        const sessionUrl = readSessionUrlParameter(searchParams);

        if ((!data && !sessionUrl) || location.state == SKIP_EVENT_LISTENER) {
            return;
        }

        let consumed = false;
        if (data) {
            const event = listener.readAppEvent(data, "event_listener");
            if (event != null) {
                listener.dispatchAppEvent(event);
                consumed = true;
            }
        } else if (sessionUrl) {
            listener.dispatchSessionUrl(sessionUrl);
            consumed = true;
        }
        if (consumed) {
            // Consume the event before an import can trigger a reload. Leaving `data` in the address
            // would dispatch the same session again and immediately reopen the conflict dialog.
            searchParams.delete(EVENT_QUERY_PARAMETER);
            searchParams.delete(SESSION_QUERY_PARAMETER);
            searchParams.delete(LEGACY_SESSION_QUERY_PARAMETER);
            const search = searchParams.toString();
            const nextUrl = `${location.pathname}${search ? `?${search}` : ''}${location.hash}`;
            globalThis.history.replaceState(globalThis.history.state, '', nextUrl);
        }
    }, [documentSearch, location.state, listener]);

    return (
        <LISTENER_CTX.Provider value={listener}>
            {props.children}
        </LISTENER_CTX.Provider>
    )
};
