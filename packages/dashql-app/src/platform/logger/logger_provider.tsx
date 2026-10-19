import * as React from 'react';

import { Logger } from './logger.js';
import { WebLogger } from './web_logger.js';

const LOGGER_CTX = React.createContext<Logger | null>(null);
let GLOBAL_LOGGER: Logger | null;
export function getGlobalLogger(): Logger | null { return GLOBAL_LOGGER; }

export const useLogger = () => React.useContext(LOGGER_CTX)!;

type Props = {
    children: React.ReactElement | React.ReactElement[];
};

export const LoggerProvider: React.FC<Props> = (props: Props) => {
    const logger = React.useMemo<Logger>(() => {
        const logger: Logger = new WebLogger();
        GLOBAL_LOGGER = logger;
        return logger;
    }, []);
    return (
        <LOGGER_CTX.Provider value={logger}>
            {props.children}
        </LOGGER_CTX.Provider>
    )
};

/// Poll the log version and translate into React state.
/// We deliberately do not use eager state updates from the log flusher.
/// Pass enabled = false to skip polling, e.g. when a trace subscription already drives the component.
export function pollLogVersion(interval: number = 100, enabled: boolean = true) {
    const logger = useLogger();
    const [logVersion, setLogVersion] = React.useState<number>(logger.buffer.version);
    // Compare against a ref, the interval closure would otherwise only see the initial version
    const logVersionRef = React.useRef<number>(logVersion);
    React.useEffect(() => {
        if (!enabled) {
            return;
        }
        const intervalId = setInterval(() => {
            const version = logger.buffer.version;
            if (version !== logVersionRef.current) {
                logVersionRef.current = version;
                setLogVersion(version);
            }
        }, interval);
        return () => {
            clearInterval(intervalId);
        };
    }, [logger, interval, enabled]);
    return logVersion;
}
