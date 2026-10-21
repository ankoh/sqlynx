import * as React from 'react';

import { AIClient, AIClientSettings } from './ai_client.js';
import { useHttpClient } from '../http/http_client_provider.js';
import { useLogger } from '../logger/logger_provider.js';
import {
    AIProviderSettings,
    DEFAULT_AI_ENDPOINT_URL,
    DEFAULT_AI_MODEL,
    useAppConfig,
} from '../../app/config/app_config.js';

type Props = {
    children: React.ReactElement;
};

const CLIENT_CTX = React.createContext<AIClient | null>(null);
export const useAIClient = () => React.useContext(CLIENT_CTX);

export function resolveAIClientSettings(settings: AIProviderSettings | undefined): AIClientSettings | null {
    if (settings?.enabled !== true) return null;
    return {
        endpointUrl: settings?.endpointUrl ?? DEFAULT_AI_ENDPOINT_URL,
        model: settings?.model ?? DEFAULT_AI_MODEL,
        headers: settings?.headers ?? [],
        auth: settings?.auth ?? { type: 'none' },
    };
}

export const AIClientProvider: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const httpClient = useHttpClient();
    const config = useAppConfig();
    const stored = config?.settings?.aiProvider;
    const settings = resolveAIClientSettings(stored);

    const client = React.useMemo<AIClient | null>(() => {
        if (logger == null || httpClient == null || settings == null) return null;
        return new AIClient(logger, httpClient, settings);
    }, [logger, httpClient, settings?.endpointUrl, settings?.model, settings?.headers, settings?.auth]);

    return <CLIENT_CTX.Provider value={client}>{props.children}</CLIENT_CTX.Provider>;
};
