import {
    CHANNEL_READY,
    CHANNEL_SETUP_STARTED,
    SETUP_CANCELLED,
    SETUP_FAILED,
    HyperGrpcConnectorAction,
} from './hyper_grpc_connection_state.js';
import { Logger } from '../platform/logger.js';
import { HyperGrpcConnectionParams } from './connection_params.js';
import { HyperGrpcConnectorConfig } from './connector_configs.js';
import { Dispatch } from '../utils/index.js';
import { AttachedDatabase, HyperDatabaseClient, HyperDatabaseConnectionContext } from '../platform/hyperdb_client.js';


export async function setupHyperGrpcConnection(dispatch: Dispatch<HyperGrpcConnectorAction>, logger: Logger, params: HyperGrpcConnectionParams, _config: HyperGrpcConnectorConfig, client: HyperDatabaseClient, abortSignal: AbortSignal): Promise<void> {
    try {
        // Start the channel setup
        dispatch({
            type: CHANNEL_SETUP_STARTED,
            value: params,
        });
        abortSignal.throwIfAborted()

        // XXX Dummy connection context
        const connectionContext: HyperDatabaseConnectionContext = {
            getAttachedDatabases(): AttachedDatabase[] {
                return []
            },
            getRequestMetadata(): Promise<Record<string, string>> {
                return Promise.resolve({});
            }
        };

        // Create the channel
        const channel = await client.connect(params.channel, connectionContext);
        abortSignal.throwIfAborted();

        // Mark the channel as ready
        dispatch({
            type: CHANNEL_READY,
            value: channel,
        });
        abortSignal.throwIfAborted();

        // Start a health check

    } catch (error: any) {
        if (error.name === 'AbortError') {
            logger.warn("setup was aborted");
            dispatch({
                type: SETUP_CANCELLED,
                value: error.message,
            });
        } else if (error instanceof Error) {
            logger.error(`setup failed with error: ${error.toString()}`);
            dispatch({
                type: SETUP_FAILED,
                value: error.message,
            });
        }
    }
}
