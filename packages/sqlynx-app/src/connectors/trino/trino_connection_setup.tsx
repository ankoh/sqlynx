import {
    CHANNEL_READY,
    CHANNEL_SETUP_CANCELLED,
    CHANNEL_SETUP_FAILED,
    CHANNEL_SETUP_STARTED,
    HEALTH_CHECK_CANCELLED,
    HEALTH_CHECK_FAILED,
    HEALTH_CHECK_STARTED,
    HEALTH_CHECK_SUCCEEDED,
    TrinoConnectorAction,
} from './trino_connection_state.js';
import { Dispatch } from '../../utils/index.js';
import { Logger } from '../../platform/logger.js';
import { RESET } from '../connection_state.js';
import { TrinoApiClientInterface, TrinoApiEndpoint } from './trino_api_client.js';
import { TrinoChannel, TrinoChannelInterface } from './trino_channel.js';
import { TrinoConnectionParams } from './trino_connection_params.js';
import { TrinoConnectorConfig } from '../connector_configs.js';

const LOG_CTX = "trino_setup";

export async function setupTrinoConnection(dispatch: Dispatch<TrinoConnectorAction>, logger: Logger, params: TrinoConnectionParams, _config: TrinoConnectorConfig, client: TrinoApiClientInterface, abortSignal: AbortSignal): Promise<TrinoChannelInterface | null> {
    // First prepare the channel
    let channel: TrinoChannelInterface;
    try {
        // Start the channel setup
        dispatch({
            type: CHANNEL_SETUP_STARTED,
            value: params,
        });
        abortSignal.throwIfAborted()

        // Create the channel
        const endpoint: TrinoApiEndpoint = {
            endpoint: params.channelArgs.endpoint,
            auth: params.authParams
        };
        channel = new TrinoChannel(logger, client, endpoint);

        // Mark the channel as ready
        dispatch({
            type: CHANNEL_READY,
            value: channel,
        });
        abortSignal.throwIfAborted();

    } catch (error: any) {
        if (error.name === 'AbortError') {
            logger.warn("setup was aborted", LOG_CTX);
            dispatch({
                type: CHANNEL_SETUP_CANCELLED,
                value: error.message,
            });
        } else if (error instanceof Error) {
            logger.error(`setup failed with error: ${error.toString()}`, LOG_CTX);
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
            logger.warn("setup was aborted", LOG_CTX);
            dispatch({
                type: HEALTH_CHECK_CANCELLED,
                value: error.message,
            });
        } else if (error instanceof Error) {
            logger.error(`setup failed with error: ${error.toString()}`, LOG_CTX);
            dispatch({
                type: CHANNEL_SETUP_FAILED,
                value: error.message,
            });
        }
        return null;
    }
    return channel;
}
export interface TrinoSetupApi {
    setup(dispatch: Dispatch<TrinoConnectorAction>, params: TrinoConnectionParams, abortSignal: AbortSignal): Promise<void>
    reset(dispatch: Dispatch<TrinoConnectorAction>): Promise<void>
}

export function createTrinoSetupFlow(trinoClient: TrinoApiClientInterface, config: TrinoConnectorConfig, logger: Logger): (TrinoSetupApi | null) {
    const setup = async (dispatch: Dispatch<TrinoConnectorAction>, params: TrinoConnectionParams, abort: AbortSignal) => {
        await setupTrinoConnection(dispatch, logger, params, config, trinoClient, abort);
    };
    const reset = async (dispatch: Dispatch<TrinoConnectorAction>) => {
        dispatch({
            type: RESET,
            value: null,
        })
    };
    return { setup, reset };
};
