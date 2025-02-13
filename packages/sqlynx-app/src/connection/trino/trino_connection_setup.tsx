import {
    CHANNEL_READY,
    CHANNEL_SETUP_CANCELLED,
    CHANNEL_SETUP_FAILED,
    CHANNEL_SETUP_STARTED,
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

export async function setupTrinoConnection(updateState: Dispatch<TrinoConnectorAction>, logger: Logger, params: TrinoConnectionParams, _config: TrinoConnectorConfig, client: TrinoApiClientInterface, abortSignal: AbortSignal): Promise<TrinoChannelInterface> {
    // First prepare the channel
    let channel: TrinoChannelInterface;
    try {
        // Start the channel setup
        updateState({
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
        updateState({
            type: CHANNEL_READY,
            value: channel,
        });
        abortSignal.throwIfAborted();

    } catch (error: any) {
        if (error.name === 'AbortError') {
            logger.warn("setup was aborted", LOG_CTX);
            updateState({
                type: CHANNEL_SETUP_CANCELLED,
                value: error.message,
            });
        } else if (error instanceof Error) {
            logger.error(`setup failed with error: ${error.toString()}`, LOG_CTX);
            updateState({
                type: CHANNEL_SETUP_FAILED,
                value: error.message,
            });
        }
        throw error;
    }
    return channel;
}
export interface TrinoSetupApi {
    setup(dispatch: Dispatch<TrinoConnectorAction>, params: TrinoConnectionParams, abortSignal: AbortSignal): Promise<TrinoChannelInterface | null>
    reset(dispatch: Dispatch<TrinoConnectorAction>): Promise<void>
}

export function createTrinoSetupFlow(trinoClient: TrinoApiClientInterface, config: TrinoConnectorConfig, logger: Logger): (TrinoSetupApi | null) {
    const setup = async (updateState: Dispatch<TrinoConnectorAction>, params: TrinoConnectionParams, abort: AbortSignal) => {
        return await setupTrinoConnection(updateState, logger, params, config, trinoClient, abort);
    };
    const reset = async (updateState: Dispatch<TrinoConnectorAction>) => {
        updateState({
            type: RESET,
            value: null,
        })
    };
    return { setup, reset };
};
