import * as React from 'react';

import { ConnectorConfigs, readConnectorConfigs } from '../notebook/connections/connector_configs.js';
import { useLogger } from '../../platform/logger/logger_provider.js';
import { Logger } from '../../platform/logger/logger.js';
import { createTrace } from '../../platform/logger/trace_context.js';

const CONFIG_URL = new URL('../../../static/config.json', import.meta.url);

export interface AIProviderHeader {
    name: string;
    value: string;
}

/// How the AI provider requests are authorized
export type AIProviderAuthType = 'none' | 'basic' | 'bearer';

/// The credentials of every method are kept, switching the method does not lose them
export interface AIProviderAuth {
    type?: AIProviderAuthType;
    username?: string;
    password?: string;
    token?: string;
}

export interface AIProviderSettings {
    enabled?: boolean;
    endpointUrl?: string;
    model?: string;
    headers?: AIProviderHeader[];
    auth?: AIProviderAuth;
}

export const DEFAULT_AI_ENDPOINT_URL = "http://127.0.0.1:4097";
export const DEFAULT_AI_MODEL = "gpt-6-luna";

export const DEFAULT_AI_PROVIDER_SETTINGS: AIProviderSettings = {
    endpointUrl: DEFAULT_AI_ENDPOINT_URL,
    model: DEFAULT_AI_MODEL,
    headers: [],
};

export interface AppSettings {
    pauseAfterAppSetup?: boolean;
    enableTableColumnPlots?: boolean;
    experimental_dashboards?: boolean;
    experimental_file_attachments?: boolean;
    narrowScreenLayout?: boolean;
    scriptDebugMode?: boolean;
    tableDebugMode?: boolean;
    formattingDebugMode?: boolean;
    keywordCase?: 'lower' | 'upper';
    /// Force the OAuth identity provider to re-prompt for login instead of silently reusing an
    /// existing browser session. Adds `prompt=login` to the authorization request.
    forceReLogin?: boolean;
    minLogLevel?: number;
    aiProvider?: AIProviderSettings;
}

export interface AppConfig {
    settings?: AppSettings;
    connectors?: ConnectorConfigs;
}

function readAppConfig(object: Record<string, object>): AppConfig {
    if (object.connectors) {
        object.connectors = readConnectorConfigs(object.connectors);
    }
    return object as AppConfig;
}

export interface AppConfigResult {
    config: AppConfig;
    traceId: number;
}

export async function downloadAppConfig(logger: Logger): Promise<AppConfigResult> {
    const trace = createTrace();
    const traced = logger.withTrace(trace);
    try {
        const resp = await fetch(CONFIG_URL as unknown as string);
        const body = await resp.json();
        const config = readAppConfig(body);
        traced.info("Loaded app config", {}, "app_config");
        return { config, traceId: trace.traceId };
    } catch (e: any) {
        console.error(e);
        throw e;
    }
};

type ReconfigureStateFn = (res: AppConfig | null) => (AppConfig | null);
const RECONFIGURE_CTX = React.createContext<((config: ReconfigureStateFn) => void) | null>(null);
const CONFIG_CTX = React.createContext<AppConfig | null>(null);
const CONFIG_TRACE_ID_CTX = React.createContext<number | null>(null);

type Props = {
    children: React.ReactElement;
};

export const AppConfigProvider: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const configPromise = React.useRef<Promise<AppConfigResult>>(null);
    const [config, setConfig] = React.useState<AppConfig | null>(null);
    const [traceId, setTraceId] = React.useState<number | null>(null);

    React.useEffect(() => {
        if (!configPromise.current) {
            configPromise.current = downloadAppConfig(logger);
            configPromise.current.then(result => {
                setConfig(result.config);
                setTraceId(result.traceId);
            }).catch(() => {
                setConfig(null);
                setTraceId(null);
            });
        }
    }, []);

    const reconfigure = React.useCallback((mapper: ReconfigureStateFn) => {
        logger.info(`Reconfiguring application`, {}, "app_config");
        setConfig(c => mapper(c));
    }, []);

    return (
        <CONFIG_CTX.Provider value={config}>
            <CONFIG_TRACE_ID_CTX.Provider value={traceId}>
                <RECONFIGURE_CTX.Provider value={reconfigure}>{props.children}</RECONFIGURE_CTX.Provider>
            </CONFIG_TRACE_ID_CTX.Provider>
        </CONFIG_CTX.Provider>
    );
};

export const useAppConfig = (): AppConfig | null => React.useContext(CONFIG_CTX);
export const useAppConfigTraceId = (): number | null => React.useContext(CONFIG_TRACE_ID_CTX);
export const useAppReconfigure = (): ((config: ReconfigureStateFn) => void) => React.useContext(RECONFIGURE_CTX)!;
