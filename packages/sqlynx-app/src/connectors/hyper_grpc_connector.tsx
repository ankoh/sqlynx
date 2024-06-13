import * as React from 'react';

import { Dispatch } from '../utils/variant.js';
import { HyperGrpcConnectionParams } from './connection_params.js';
import { HyperGrpcSetupProvider } from './hyper_grpc_setup.js';
import { createHyperGrpcConnectionState, HyperGrpcConnectorAction } from './hyper_grpc_connection_state.js';
import { useAllocatedConnectionState } from './connection_registry.js';

export interface HyperGrpcConnectorApi {
    setup(dispatch: Dispatch<HyperGrpcConnectorAction>, params: HyperGrpcConnectionParams, abortSignal: AbortSignal): Promise<void>
    reset(dispatch: Dispatch<HyperGrpcConnectorAction>): Promise<void>
};

const CONNECTION_ID_CTX = React.createContext<number | null>(null);

interface Props {
    children: React.ReactElement;
}

export const HyperGrpcConnector: React.FC<Props> = (props: Props) => {
    // Pre-allocate a connection id for all Hyper gRPC connections.
    // c.f. salesforce_connector
    const connectionId = useAllocatedConnectionState((_) => createHyperGrpcConnectionState());

    return (
        <CONNECTION_ID_CTX.Provider value={connectionId}>
            <HyperGrpcSetupProvider>
                {props.children}
            </HyperGrpcSetupProvider>
        </CONNECTION_ID_CTX.Provider>
    );
};

export const useHyperGrpcConnectionId = (): number => React.useContext(CONNECTION_ID_CTX)!;
