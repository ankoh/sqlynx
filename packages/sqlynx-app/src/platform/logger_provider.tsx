import * as React from 'react';

import { Logger } from './logger.js';
import { getNativeGlobals, isNativePlatform } from './native_globals.js';
import { NativeLogger } from './native_logger.js';
import { WebLogger } from './web_logger.js';

const LOGGER_CTX = React.createContext<Logger | null>(null);

export const useLogger = () => React.useContext(LOGGER_CTX)!;

type Props = {
    children: React.ReactElement;
};

export const LoggerProvider: React.FC<Props> = (props: Props) => {
    // Synchronously setup a logger
    const logger = React.useMemo<Logger>(() => isNativePlatform() ? new NativeLogger(getNativeGlobals()) : new WebLogger(), []);

    // Maintain a log buffer version
    return (
        <LOGGER_CTX.Provider value={logger}>
            {props.children}
        </LOGGER_CTX.Provider>
    )
};
