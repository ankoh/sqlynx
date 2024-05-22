import * as React from 'react';

import { HYPER_GRPC_CONNECTOR } from './connector_info.js';
import { useAllocatedConnectionState } from './connection_registry.js';
import { useAppConfig } from '../app_config.js';
import { useLogger } from '../platform/logger_provider.js';
import { Dispatch } from '../utils/variant.js';
import { createHyperGrpcConnectionState, HyperGrpcConnectorAction, RESET } from './hyper_grpc_connection_state.js';
import { HyperGrpcConnectionParams } from './connection_params.js';

export interface HyperGrpcConnectorApi {
    setup(dispatch: Dispatch<HyperGrpcConnectorAction>, params: HyperGrpcConnectionParams, abortSignal: AbortSignal): Promise<void>
    reset(dispatch: Dispatch<HyperGrpcConnectorAction>): Promise<void>
};

const CONNECTION_ID_CTX = React.createContext<number | null>(null);
const API_CTX = React.createContext<HyperGrpcConnectorApi | null>(null);

export const useHyperGrpcConnectorApi = () => React.useContext(API_CTX!);

interface Props {
    children: React.ReactElement;
}

export const HyperGrpcConnector: React.FC<Props> = (props: Props) => {
    const _logger = useLogger();
    const appConfig = useAppConfig();
    const connectorConfig = appConfig.value?.connectors?.hyperGrpc ?? null;

    // Create the connector api
    const api = React.useMemo<HyperGrpcConnectorApi | null>(() => {
        const setup = async (_dispatch: Dispatch<HyperGrpcConnectorAction>, _params: HyperGrpcConnectionParams, _abort: AbortSignal) => {

            // XXX
        };
        const reset = async (dispatch: Dispatch<HyperGrpcConnectorAction>) => {
            dispatch({
                type: RESET,
                value: null,
            })
        };
        return { setup, reset };
    }, [connectorConfig]);

    // Pre-allocate a connection id for all Hyper gRPC connections.
    // c.f. salesforce_connector
    const connectionId = useAllocatedConnectionState((_) => ({
        type: HYPER_GRPC_CONNECTOR,
        value: createHyperGrpcConnectionState()
    }));
    return (
        <CONNECTION_ID_CTX.Provider value={connectionId}>
            <API_CTX.Provider value={api}>
                {props.children}
            </API_CTX.Provider>
        </CONNECTION_ID_CTX.Provider>
    );
};

export const useHyperGrpcConnectionId = (): number => React.useContext(CONNECTION_ID_CTX)!;
