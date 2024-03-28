import * as React from 'react';
import { Maybe, MaybeStatus } from './utils/maybe.js';
import { ConnectorConfigs, readConnectorConfigs } from './connectors/connector_configs.js';
import { useLogger } from './platform/logger_provider.js';
import { SQLYNX_BUILD_MODE, SQLYNX_GIT_COMMIT, SQLYNX_VERSION } from './globals.js';

const CONFIG_URL = new URL('../static/config.json', import.meta.url);

export interface AppFeatures {
    completionDetails?: boolean;
    grpcConnector?: boolean;
    refreshSchema?: boolean;
    saveQueryAsSql?: boolean;
    saveResultsAsArrow?: boolean;
}

export interface AppConfig {
    features?: AppFeatures;
    connectors?: ConnectorConfigs;
}

export function readAppConfig(object: any): AppConfig {
    if (object.connectors) {
        object.connectors = readConnectorConfigs(object.connectors);
    }
    return object as AppConfig;
}

const configCtx = React.createContext<Maybe<AppConfig> | null>(null);
const reconfigureCtx = React.createContext<((config: AppConfig) => void) | null>(null);

type Props = {
    children: React.ReactElement;
};

export const AppConfigProvider: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const [config, setConfig] = React.useState<Maybe<AppConfig>>(new Maybe<AppConfig, null>(MaybeStatus.NONE, null));
    const started = React.useRef<boolean>(false);
    if (!started.current) {
        started.current = true;
        const resolve = async (): Promise<void> => {
            try {
                const resp = await fetch(CONFIG_URL as unknown as string);
                const body = await resp.json();
                const config = readAppConfig(body);
                setConfig(c => c.completeWith(config));
                logger.info("configured application", "app_config");
                if (SQLYNX_BUILD_MODE == 'development') {
                    logger.info(`react is running in strict mode and will duplicate events`, "app_config")
                }
            } catch (e: any) {
                console.error(e);
                setConfig(c => c.failWith(e));
            }
        };
        resolve();
    }
    const reconfigure = (next: AppConfig) => setConfig(c => c.completeWith(next));
    return (
        <configCtx.Provider value={config}>
            <reconfigureCtx.Provider value={reconfigure}>{props.children}</reconfigureCtx.Provider>
        </configCtx.Provider>
    );
};

export const useAppConfig = (): Maybe<AppConfig> => React.useContext(configCtx)!;
export const useAppReconfigure = (): ((config: AppConfig) => void) => React.useContext(reconfigureCtx)!;
