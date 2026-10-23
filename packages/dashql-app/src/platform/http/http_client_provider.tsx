import * as React from 'react';

import { useLogger } from '../logger/logger_provider.js';
import { isDesktopHost } from '../native_globals.js';
import { NativeHttpClient } from './native_http_client.js';
import { WebHttpClient } from './web_http_client.js';
import { HttpClient } from './http_client.js';

type Props = {
    children: React.ReactElement;
};

const CLIENT_CTX = React.createContext<HttpClient | null>(null);
export const useHttpClient = () => React.useContext(CLIENT_CTX)!;

export const HttpClientProvider: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const client = React.useMemo<HttpClient>(() => isDesktopHost()
        ? new NativeHttpClient({ proxyEndpoint: new URL("dashql-native://localhost") }, logger)
        : new WebHttpClient(logger), [logger]);
    return (
        <CLIENT_CTX.Provider value={client}>{props.children}</CLIENT_CTX.Provider>
    );
};
