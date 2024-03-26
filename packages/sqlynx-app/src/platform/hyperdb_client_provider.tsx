import * as React from 'react';

import { isNativePlatform } from './native_globals.js';
import { HyperDatabaseClient } from './hyperdb_client.js';
import { NativeHyperDatabaseClient } from './native_hyperdb_client.js';

type Props = {
    children: React.ReactElement;
};

const CLIENT_CTX = React.createContext<HyperDatabaseClient | null>(null);
export const useHyperDatabaseClient = () => React.useContext(CLIENT_CTX);

export const HyperDatabaseClientProvider: React.FC<Props> = (props: Props) => {
    const [client, setClient] = React.useState<HyperDatabaseClient | null>(null);
    React.useEffect(() => {
        if (isNativePlatform()) {
            const client = new NativeHyperDatabaseClient({ proxyEndpoint: new URL("sqlynx-native://localhost") });
            setClient(client);
        }
    }, []);
    return <CLIENT_CTX.Provider value={client}>{props.children}</CLIENT_CTX.Provider>;
};
