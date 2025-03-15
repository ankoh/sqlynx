import * as React from 'react';

import { isNativePlatform } from '../../platform/native_globals.js';
import { HyperDatabaseClient } from '../../connection/hyper/hyperdb_client.js';
import { NativeHyperDatabaseClient } from '../../platform/native_hyperdb_client.js';
import { useLogger } from '../../platform/logger_provider.js';

type Props = {
    children: React.ReactElement;
};

const CLIENT_CTX = React.createContext<HyperDatabaseClient | null>(null);
export const useHyperDatabaseClient = () => React.useContext(CLIENT_CTX);

export const HyperDatabaseClientProvider: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const [client, setClient] = React.useState<HyperDatabaseClient | null>(null);
    React.useEffect(() => {
        if (isNativePlatform()) {
            const client = new NativeHyperDatabaseClient({ proxyEndpoint: new URL("dashql-native://localhost") }, logger);
            setClient(client);
        }
    }, []);
    return <CLIENT_CTX.Provider value={client}>{props.children}</CLIENT_CTX.Provider>;
};
