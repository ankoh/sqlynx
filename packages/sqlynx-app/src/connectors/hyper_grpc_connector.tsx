import * as React from 'react';
import { useAllocatedConnectionState } from './connection_registry.js';
import { HYPER_GRPC_CONNECTOR as HYPER_GRPC_CONNECTOR } from './connector_info.js';
import { createEmptyTimings } from './connection_state.js';

const CONNECTION_ID_CTX = React.createContext<number | null>(null);

interface Props {
    children: React.ReactElement;
}

export const HyperGrpcConnector: React.FC<Props> = (props: Props) => {
    // Pre-allocate a connection id for all Hyper gRPC connections.
    // c.f. salesforce_connector
    const connectionId = useAllocatedConnectionState((_) => ({
        type: HYPER_GRPC_CONNECTOR,
        value: {
            connectionTimings: createEmptyTimings(),
            connection: null,
        }
    }));
    return (
        <CONNECTION_ID_CTX.Provider value={connectionId}>
            {props.children}
        </CONNECTION_ID_CTX.Provider>
    );
};

export const useHyperGrpcConnectionId = (): number => React.useContext(CONNECTION_ID_CTX)!;
