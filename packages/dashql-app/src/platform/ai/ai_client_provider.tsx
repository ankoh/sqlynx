import * as React from 'react';

import { AIClient, AIClientSettings } from './ai_client.js';
import { useHttpClient } from '../http/http_client_provider.js';
import { useLogger } from '../logger/logger_provider.js';
import {
    AIProviderAuth,
    AIProviderHeader,
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

// Shared defaults keep the memoized client stable across renders
const NO_HEADERS: AIProviderHeader[] = [];
const NO_AUTH: AIProviderAuth = { type: 'none' };

/// Is the endpoint an absolute URL?
function isValidEndpointUrl(endpointUrl: string): boolean {
    try {
        new URL(endpointUrl);
        return true;
    } catch {
        return false;
    }
}

/// The settings of the AI client, null unless AI is enabled and has an endpoint and a model
export function resolveAIClientSettings(settings: AIProviderSettings | undefined): AIClientSettings | null {
    if (settings?.enabled !== true) return null;
    const endpointUrl = (settings.endpointUrl ?? DEFAULT_AI_ENDPOINT_URL).trim();
    const model = (settings.model ?? DEFAULT_AI_MODEL).trim();
    if (endpointUrl.length === 0 || model.length === 0 || !isValidEndpointUrl(endpointUrl)) return null;
    return {
        endpointUrl,
        model,
        headers: settings.headers ?? NO_HEADERS,
        auth: settings.auth ?? NO_AUTH,
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
