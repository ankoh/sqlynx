import * as React from 'react';

import { OAuthListener } from './oauth_listener.js';
import { NativeOAuthListener } from './native_oauth_listener.js';
import { WebOAuthListener } from './web_oauth_listener.js';
import { isNativePlatform } from './native_globals.js';

const LISTENER_CTX = React.createContext<OAuthListener | null>(null);

export const useOAuthListener = () => React.useContext(LISTENER_CTX)!;

type Props = {
    children: React.ReactElement;
};

export const OAuthListenerProvider: React.FC<Props> = (props: Props) => {
    // Synchronously setup a oauth listener
    const logger = React.useMemo<OAuthListener>(() => isNativePlatform() ? new NativeOAuthListener() : new WebOAuthListener(), []);

    // Maintain a log buffer version
    return (
        <LISTENER_CTX.Provider value={logger}>
            {props.children}
        </LISTENER_CTX.Provider>
    )
};

