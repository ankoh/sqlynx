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
    TrinoConnectorAction,
} from './trino_connection_state.js';
import { Logger } from '../../platform/logger.js';
import { TrinoConnectionParams } from './trino_connection_params.js';
import { TrinoConnectorConfig } from '../connector_configs.js';
import { Dispatch } from '../../utils/index.js';
import {
    AttachedDatabase,
    HyperDatabaseConnectionContext,
} from '../../connectors/hyper/hyperdb_client.js';
import { useLogger } from '../../platform/logger_provider.js';
import { useAppConfig } from '../../app_config.js';
import { useHyperDatabaseClient } from '../../connectors/hyper/hyperdb_client_provider.js';
import { RESET } from '../connection_state.js';
import { TrinoClientInterface } from './trino_api_client.js';
import { TrinoChannel } from './trino_channel.js';

export async function setupTrinoConnection(dispatch: Dispatch<TrinoConnectorAction>, logger: Logger, params: TrinoConnectionParams, _config: TrinoConnectorConfig, client: TrinoClientInterface, abortSignal: AbortSignal): Promise<TrinoChannel | null> {
    // First prepare the channel
    let channel: TrinoChannel;
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
                return [];
            },
            async getRequestMetadata(): Promise<Record<string, string>> {
                const headers: Record<string, string> = {};
                for (const md of params.metadata) {
                    headers[md.key] = md.value;
                }
                return headers;
            }
        };

        // Create the channel
        channel = await client.connect(params.channelArgs, connectionContext);
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
export interface TrinoSetupApi {
    setup(dispatch: Dispatch<TrinoConnectorAction>, params: TrinoConnectionParams, abortSignal: AbortSignal): Promise<void>
    reset(dispatch: Dispatch<TrinoConnectorAction>): Promise<void>
}

export const SETUP_CTX = React.createContext<TrinoSetupApi | null>(null);
export const useTrinoSetup = () => React.useContext(SETUP_CTX!);

interface Props {
    /// The children
    children: React.ReactElement;
}

export const TrinoSetupProvider: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const appConfig = useAppConfig();
    const connectorConfig = appConfig.value?.connectors?.hyper ?? null;
    const hyperClient = useHyperDatabaseClient();

    const api = React.useMemo<TrinoSetupApi | null>(() => {
        if (!connectorConfig || !hyperClient) {
            return null;
        }
        const setup = async (dispatch: Dispatch<TrinoConnectorAction>, params: TrinoConnectionParams, abort: AbortSignal) => {
            await setupTrinoConnection(dispatch, logger, params, connectorConfig, hyperClient, abort);
        };
        const reset = async (dispatch: Dispatch<TrinoConnectorAction>) => {
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
