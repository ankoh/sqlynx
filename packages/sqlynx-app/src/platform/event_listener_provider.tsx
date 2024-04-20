import * as React from 'react';

import { AppEventListener } from './event_listener.js';
import { NativeAppEventListener } from './native_event_listener.js';
import { WebAppEventListener } from './web_event_listener.js';
import { isNativePlatform } from './native_globals.js';
import { useLogger } from './logger_provider.js';

const LISTENER_CTX = React.createContext<AppEventListener | null>(null);

export const useAppEventListener = () => React.useContext(LISTENER_CTX)!;

type Props = {
    children: React.ReactElement;
};

export const AppEventListenerProvider: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const listener = React.useMemo<AppEventListener>(() => {
        const l = isNativePlatform() ? new NativeAppEventListener(logger) : new WebAppEventListener(logger);
        l.listen();
        return l;
    }, []);
    return (
        <LISTENER_CTX.Provider value={listener}>
            {props.children}
        </LISTENER_CTX.Provider>
    )
};

