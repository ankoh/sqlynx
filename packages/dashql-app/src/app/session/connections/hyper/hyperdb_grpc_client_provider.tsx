import * as React from 'react';

import { isDesktopHost } from '../../../../platform/native_globals.js';
import { HyperDatabaseClient } from './hyperdb_grpc_client.js';
import { NativeHyperDatabaseClient } from './platform/native_hyperdb_grpc_client.js';
import { WebHyperDatabaseClient } from './platform/web_hyperdb_http_client.js';
import { useHttpClient } from '../../../../platform/http/http_client_provider.js';
import { useLogger } from '../../../../platform/logger/logger_provider.js';

type Props = {
    children: React.ReactElement;
};

const GRPC_CLIENT_CTX = React.createContext<HyperDatabaseClient | null>(null);
const HTTP_CLIENT_CTX = React.createContext<HyperDatabaseClient | null>(null);

export const useHyperGrpcClient = () => React.useContext(GRPC_CLIENT_CTX);
export const useHyperHttpClient = () => React.useContext(HTTP_CLIENT_CTX);

export const HyperDatabaseClientProvider: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const httpClient = useHttpClient();
    const [grpcClient, setGrpcClient] = React.useState<HyperDatabaseClient | null>(null);
    const [httpHyperClient, setHttpHyperClient] = React.useState<HyperDatabaseClient | null>(null);
    React.useEffect(() => {
        if (isDesktopHost()) {
            setGrpcClient(new NativeHyperDatabaseClient({ proxyEndpoint: new URL("dashql-native://localhost") }, logger));
        }
        if (httpClient) {
            setHttpHyperClient(new WebHyperDatabaseClient(httpClient, logger));
        }
    }, [httpClient]);
    return (
        <GRPC_CLIENT_CTX.Provider value={grpcClient}>
            <HTTP_CLIENT_CTX.Provider value={httpHyperClient}>
                {props.children}
            </HTTP_CLIENT_CTX.Provider>
        </GRPC_CLIENT_CTX.Provider>
    );
};
