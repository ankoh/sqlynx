import * as React from 'react';

import { Logger } from './logger.js';
import { getNativeGlobals, isNativePlatform } from './native_globals.js';
import { NativeLogger } from './native_logger.js';
import { WebLogger } from './web_logger.js';

const LOGGER_CTX = React.createContext<Logger | null>(null);
const LOG_BUFFER_VERSION_CTX = React.createContext<number>(0);

export const useLogger = () => React.useContext(LOGGER_CTX)!;
export const useLogVersion = () => React.useContext(LOG_BUFFER_VERSION_CTX)!;

type Props = {
    children: React.ReactElement;
};

export const LoggerProvider: React.FC<Props> = (props: Props) => {
    // Synchronously setup a logger
    const logger = React.useMemo<Logger>(() => isNativePlatform() ? new NativeLogger(getNativeGlobals()) : new WebLogger(), []);

    // Maintain a log buffer version
    const [version, setVersion] = React.useState<number>(0);
    const versionCallback = React.useCallback(() => setVersion(v => v + 1), []);
    React.useEffect(() => {
        logger.buffer.observe(versionCallback, true);
        return () => {
            logger.buffer.observers.delete(versionCallback)
        };
    }, []);
    return (
        <LOGGER_CTX.Provider value={logger}>
            <LOG_BUFFER_VERSION_CTX.Provider value={version}>
                {props.children}
            </LOG_BUFFER_VERSION_CTX.Provider>
        </LOGGER_CTX.Provider>
    )
};
