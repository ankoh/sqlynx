import * as React from 'react';

import { useLocation } from 'react-router-dom';

import { PlatformEventListener, EVENT_QUERY_PARAMETER } from './event_listener.js';
import { NativePlatformEventListener } from './native_event_listener.js';
import { WebPlatformEventListener } from './web_event_listener.js';
import { isNativePlatform } from './native_globals.js';
import { useLogger } from './logger_provider.js';

export const SKIP_EVENT_LISTENER = Symbol("SKIP_EVENT_LISTENER");

const LISTENER_CTX = React.createContext<PlatformEventListener | null>(null);
export const usePlatformEventListener = () => React.useContext(LISTENER_CTX)!;

type Props = {
    children: React.ReactElement;
};

export const PlatformEventListenerProvider: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const location = useLocation();

    // Construct the event listener
    const listener = React.useMemo<PlatformEventListener>(() => {
        const l = isNativePlatform() ? new NativePlatformEventListener(logger) : new WebPlatformEventListener(logger);
        l.setup();
        return l;
    }, []);

    // Search for app events passed via the url parameter
    React.useEffect(() => {
        const searchParams = new URLSearchParams(location.search);
        const data = searchParams.get(EVENT_QUERY_PARAMETER);
        if (!data || location.state == SKIP_EVENT_LISTENER) {
            return;
        }
        const event = listener.readAppEvent(data, "event_listener");
        if (event != null) {
            listener.dispatchAppEvent(event);
        }
    }, [location.search]);

    return (
        <LISTENER_CTX.Provider value={listener}>
            {props.children}
        </LISTENER_CTX.Provider>
    )
};

