import * as React from 'react';

import {
    CHANNEL_READY,
    CHANNEL_SETUP_CANCELLED,
    CHANNEL_SETUP_FAILED,
    CHANNEL_SETUP_STARTED,
    HEALTH_CHECK_CANCELLED,
    HEALTH_CHECK_FAILED,
    HEALTH_CHECK_STARTED,
    HEALTH_CHECK_SUCCEEDED,
    HyperGrpcConnectorAction,
} from './hyper_grpc_connection_state.js';
import { Logger } from '../platform/logger.js';
import { HyperGrpcConnectionParams } from './connection_params.js';
import { HyperGrpcConnectorConfig } from './connector_configs.js';
import { Dispatch } from '../utils/index.js';
import {
    AttachedDatabase,
    HyperDatabaseChannel,
    HyperDatabaseClient,
    HyperDatabaseConnectionContext,
} from '../platform/hyperdb_client.js';
import { useLogger } from '../platform/logger_provider.js';
import { useAppConfig } from '../app_config.js';
import { useHyperDatabaseClient } from '../platform/hyperdb_client_provider.js';
import { RESET } from './connection_state.js';

export async function setupHyperGrpcConnection(dispatch: Dispatch<HyperGrpcConnectorAction>, logger: Logger, params: HyperGrpcConnectionParams, _config: HyperGrpcConnectorConfig, client: HyperDatabaseClient, abortSignal: AbortSignal): Promise<HyperDatabaseChannel | null> {
    // First prepare the channel
    let channel: HyperDatabaseChannel;
    try {
        // Start the channel setup
        dispatch({
            type: CHANNEL_SETUP_STARTED,
            value: params,
        });
        abortSignal.throwIfAborted()

        // Static connection context.
        // The direct gRPC Hyper connector never changes the headers it injects.
        const connectionContext: HyperDatabaseConnectionContext = {
            getAttachedDatabases(): AttachedDatabase[] {
                const dbs = [];
                for (const db of params.attachedDatabases) {
                    dbs.push({ path: db.key, alias: db.value });
                }
                return dbs;
            },
            async getRequestMetadata(): Promise<Record<string, string>> {
                const headers: Record<string, string> = {};
                for (const md of params.gRPCMetadata) {
                    headers[md.key] = md.value;
                }
                return headers;
            }
        };

        // Create the channel
        channel = await client.connect(params.channel, connectionContext);
        abortSignal.throwIfAborted();

        // Mark the channel as ready
        dispatch({
            type: CHANNEL_READY,
            value: channel,
        });
        abortSignal.throwIfAborted();

    } catch (error: any) {
        if (error.name === 'AbortError') {
            logger.warn("setup was aborted");
            dispatch({
                type: CHANNEL_SETUP_CANCELLED,
                value: error.message,
            });
        } else if (error instanceof Error) {
            logger.error(`setup failed with error: ${error.toString()}`);
            dispatch({
                type: CHANNEL_SETUP_FAILED,
                value: error.message,
            });
        }
        return null;
    }

    // Then perform an initial health check
    try {
        // Start the channel setup
        dispatch({
            type: HEALTH_CHECK_STARTED,
            value: null,
        });
        abortSignal.throwIfAborted();

        // Create the channel
        const health = await channel.checkHealth();
        abortSignal.throwIfAborted();

        if (health.ok) {
            dispatch({
                type: HEALTH_CHECK_SUCCEEDED,
                value: null,
            });
        } else {
            dispatch({
                type: HEALTH_CHECK_FAILED,
                value: health.errorMessage!,
            });
            return null;
        }
    } catch (error: any) {
        if (error.name === 'AbortError') {
            logger.warn("setup was aborted");
            dispatch({
                type: HEALTH_CHECK_CANCELLED,
                value: error.message,
            });
        } else if (error instanceof Error) {
            logger.error(`setup failed with error: ${error.toString()}`);
            dispatch({
                type: CHANNEL_SETUP_FAILED,
                value: error.message,
            });
        }
        return null;
    }
    return channel;
}
export interface HyperGrpcSetupApi {
    setup(dispatch: Dispatch<HyperGrpcConnectorAction>, params: HyperGrpcConnectionParams, abortSignal: AbortSignal): Promise<void>
    reset(dispatch: Dispatch<HyperGrpcConnectorAction>): Promise<void>
}

export const SETUP_CTX = React.createContext<HyperGrpcSetupApi | null>(null);
export const useHyperGrpcSetup = () => React.useContext(SETUP_CTX!);

interface Props {
    /// The children
    children: React.ReactElement;
}

export const HyperGrpcSetupProvider: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const appConfig = useAppConfig();
    const connectorConfig = appConfig.value?.connectors?.hyperGrpc ?? null;
    const hyperClient = useHyperDatabaseClient();

    const api = React.useMemo<HyperGrpcSetupApi | null>(() => {
        if (!connectorConfig || !hyperClient) {
            return null;
        }
        const setup = async (dispatch: Dispatch<HyperGrpcConnectorAction>, params: HyperGrpcConnectionParams, abort: AbortSignal) => {
            await setupHyperGrpcConnection(dispatch, logger, params, connectorConfig, hyperClient, abort);
        };
        const reset = async (dispatch: Dispatch<HyperGrpcConnectorAction>) => {
            dispatch({
                type: RESET,
                value: null,
            })
        };
        return { setup, reset };
    }, [connectorConfig]);

    return (
        <SETUP_CTX.Provider value={api}>{props.children}</SETUP_CTX.Provider>
    );
};
