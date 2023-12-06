import React from 'react';
import axios from 'axios';
import config_url from '../../static/config.json';
import { Maybe, MaybeStatus } from '../utils/maybe';

export interface AppFeatures {
    userAccount?: boolean;
    appInfo?: boolean;
    logViewer?: boolean;
    connections?: boolean;
    urlSharing?: boolean;
    completionDetails?: boolean;
}

export interface SalesforceConnectorConfig {
    mockAuth?: boolean;
    oauthRedirect?: string;
    instanceUrl?: string;
    clientId?: string;
    clientSecret?: string;
}

export interface ConnectorConfigs {
    salesforce?: SalesforceConnectorConfig;
}

export interface AppConfig {
    features?: AppFeatures;
    connectors?: ConnectorConfigs;
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function isAppConfig(object: any): object is AppConfig {
    return true;
    //return object.program !== undefined;
}

const configCtx = React.createContext<Maybe<AppConfig> | null>(null);
const reconfigureCtx = React.createContext<((config: AppConfig) => void) | null>(null);

type Props = {
    children: React.ReactElement;
};

export const AppConfigResolver: React.FC<Props> = (props: Props) => {
    const [config, setConfig] = React.useState<Maybe<AppConfig>>(new Maybe<AppConfig, null>(MaybeStatus.NONE, null));
    const started = React.useRef<boolean>(false);
    if (!started.current) {
        started.current = true;
        const resolve = async (): Promise<void> => {
            try {
                const resp = await axios.get(config_url as string);
                if (isAppConfig(resp.data)) {
                    setConfig(c => c.completeWith(resp.data));
                } else {
                    setConfig(c => c.failWith(new Error('invalid app config')));
                }
            } catch (e: any) {
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
