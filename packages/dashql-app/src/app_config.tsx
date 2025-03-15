import * as React from 'react';
import { StatePromise, StatePromiseMapper } from './utils/state_promise.js';
import { ConnectorConfigs, readConnectorConfigs } from './connection/connector_configs.js';
import { useLogger } from './platform/logger_provider.js';
import { DASHQL_BUILD_MODE } from './globals.js';

const CONFIG_URL = new URL('../static/config.json', import.meta.url);

export interface AppSettings {
    showCompletionDetails?: boolean;
    showEditorStats?: boolean;
    interfaceDebugMode?: boolean;
}

export interface AppConfig {
    settings?: AppSettings;
    connectors?: ConnectorConfigs;
}

export function readAppConfig(object: Record<string, object>): AppConfig {
    if (object.connectors) {
        object.connectors = readConnectorConfigs(object.connectors);
    }
    return object as AppConfig;
}

const configCtx = React.createContext<StatePromise<AppConfig> | null>(null);
const reconfigureCtx = React.createContext<((sub: StatePromiseMapper<AppConfig>) => void) | null>(null);

type Props = {
    children: React.ReactElement;
};

export const AppConfigProvider: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const [config, setConfig] = React.useState<StatePromise<AppConfig>>(new StatePromise<AppConfig>());
    const started = React.useRef<boolean>(false);
    if (!started.current) {
        started.current = true;
        const resolve = async (): Promise<void> => {
            try {
                const resp = await fetch(CONFIG_URL as unknown as string);
                const body = await resp.json();
                const config = readAppConfig(body);
                setConfig(c => c.resolve(config));
                logger.info("configured application", {}, "app_config");
                if (DASHQL_BUILD_MODE == 'development') {
                    logger.info(`react is running in strict mode and will duplicate events`, {}, "app_config")
                }
            } catch (e: any) {
                console.error(e);
                setConfig(c => c.reject(e));
            }
        };
        resolve();
    }
    const reconfigure = React.useCallback((mapper: StatePromiseMapper<AppConfig>) => {
        if (DASHQL_BUILD_MODE == 'development') {
            logger.info(`reconfigure application`, {}, "app_config");
        }
        setConfig(c => c.modify(mapper));
    }, []);
    return (
        <configCtx.Provider value={config}>
            <reconfigureCtx.Provider value={reconfigure}>{props.children}</reconfigureCtx.Provider>
        </configCtx.Provider>
    );
};

export const useAppConfig = (): StatePromise<AppConfig> => React.useContext(configCtx)!;
export const useAppReconfigure = (): ((sub: StatePromiseMapper<AppConfig>) => void) => React.useContext(reconfigureCtx)!;
