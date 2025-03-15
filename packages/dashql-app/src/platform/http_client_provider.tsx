import * as React from 'react';

import { useLogger } from './logger_provider.js';
import { isNativePlatform } from './native_globals.js';
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
    const [client, setClient] = React.useState<HttpClient | null>(null);
    React.useEffect(() => {
        let client: HttpClient;
        if (isNativePlatform()) {
            client = new NativeHttpClient({ proxyEndpoint: new URL("dashql-native://localhost") }, logger);
        } else {
            client = new WebHttpClient(logger);
        }
        setClient(client);
    }, []);
    return <CLIENT_CTX.Provider value={client}>{props.children}</CLIENT_CTX.Provider>;
};
