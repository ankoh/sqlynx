import * as sqlynx from "@ankoh/sqlynx-core";

import { VariantKind } from '../../utils/variant.js';
import { TrinoConnectionParams } from './trino_connection_params.js';
import { ConnectorType, CONNECTOR_INFOS, TRINO_CONNECTOR } from '../connector_info.js';
import {
    ConnectionHealth,
    ConnectionStatus,
    ConnectionState,
    ConnectionStateWithoutId,
    createConnectionState,
    RESET,
} from '../connection_state.js';
import { TrinoChannelInterface } from "./trino_channel.js";

export interface TrinoSetupTimings {
    /// The time when the channel setup started
    channelSetupStartedAt: Date | null;
    /// The time when the channel setup got cancelled
    channelSetupCancelledAt: Date | null;
    /// The time when the channel setup failed
    channelSetupFailedAt: Date | null;
    /// The time when the channel was marked ready
    channelReadyAt: Date | null;
}

export interface TrinoConnectionDetails {
    /// The setup timings
    setupTimings: TrinoSetupTimings;
    /// The auth params
    channelParams: TrinoConnectionParams | null;
    /// The authentication error
    channelError: string | null;
    /// The channel
    channel: TrinoChannelInterface | null;
    /// The health check error
    schemaResolutionError: string | null;
}

export function createTrinoConnectionState(lnx: sqlynx.SQLynx): ConnectionStateWithoutId {
    return createConnectionState(lnx, CONNECTOR_INFOS[ConnectorType.TRINO], {
        type: TRINO_CONNECTOR,
        value: {
            setupTimings: {
                channelSetupStartedAt: null,
                channelSetupCancelledAt: null,
                channelSetupFailedAt: null,
                channelReadyAt: null,
            },
            channelParams: null,
            channelError: null,
            channel: null,
            schemaResolutionError: null,
        }
    });
}

export function getTrinoConnectionDetails(state: ConnectionState | null): TrinoConnectionDetails | null {
    if (state == null) return null;
    switch (state.details.type) {
        case TRINO_CONNECTOR: return state.details.value;
        default: return null;
    }
}

export const CHANNEL_SETUP_CANCELLED = Symbol('CHANNEL_SETUP_CANCELLED');
export const CHANNEL_SETUP_FAILED = Symbol('CHANNEL_SETUP_FAILED');
export const CHANNEL_SETUP_STARTED = Symbol('CHANNEL_SETUP_STARTED');
export const CHANNEL_READY = Symbol('CHANNEL_READY');

export type TrinoConnectorAction =
    | VariantKind<typeof RESET, null>
    | VariantKind<typeof CHANNEL_SETUP_STARTED, TrinoConnectionParams>
    | VariantKind<typeof CHANNEL_SETUP_CANCELLED, string>
    | VariantKind<typeof CHANNEL_SETUP_FAILED, string>
    | VariantKind<typeof CHANNEL_READY, TrinoChannelInterface>
    ;

export function reduceTrinoConnectorState(state: ConnectionState, action: TrinoConnectorAction): ConnectionState | null {
    const details = state.details.value as TrinoConnectionDetails;
    let next: ConnectionState | null = null;
    switch (action.type) {
        case RESET:
            if (details.channel) {
                details.channel.close();
            }
            next = {
                ...state,
                details: {
                    type: TRINO_CONNECTOR,
                    value: {
                        ...details,
                        setupTimings: {
                            channelSetupStartedAt: new Date(),
                            channelSetupCancelledAt: null,
                            channelSetupFailedAt: null,
                            channelReadyAt: null,
                        },
                        channelParams: details.channelParams,
                        channelError: null,
                        channel: null,
                        schemaResolutionError: null,
                    }
                },
            };
            break;
        case CHANNEL_SETUP_CANCELLED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.CHANNEL_SETUP_CANCELLED,
                connectionHealth: ConnectionHealth.CANCELLED,
                details: {
                    type: TRINO_CONNECTOR,
                    value: {
                        ...details,
                        setupTimings: {
                            ...details.setupTimings,
                            channelSetupCancelledAt: new Date(),
                        },
                        channelError: action.value,
                        channel: null
                    }
                },
            };
            break;
        case CHANNEL_SETUP_FAILED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.CHANNEL_SETUP_FAILED,
                connectionHealth: ConnectionHealth.FAILED,
                details: {
                    type: TRINO_CONNECTOR,
                    value: {
                        ...details,
                        setupTimings: {
                            ...details.setupTimings,
                            channelSetupFailedAt: new Date(),
                        },
                        channelError: action.value,
                        channel: null
                    }
                },
            };
            break;
        case CHANNEL_SETUP_STARTED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.CHANNEL_SETUP_STARTED,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: TRINO_CONNECTOR,
                    value: {
                        ...details,
                        setupTimings: {
                            channelSetupStartedAt: new Date(),
                            channelSetupCancelledAt: null,
                            channelSetupFailedAt: null,
                            channelReadyAt: null,
                        },
                        channelParams: action.value,
                        channelError: null,
                        channel: null,
                        schemaResolutionError: null,
                    }
                },
            };
            break;
        case CHANNEL_READY:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.CHANNEL_READY,
                connectionHealth: ConnectionHealth.ONLINE,
                details: {
                    type: TRINO_CONNECTOR,
                    value: {
                        ...details,
                        setupTimings: {
                            ...details.setupTimings,
                            channelReadyAt: new Date(),
                        },
                        channel: action.value
                    }
                },
            };
            break;
    }
    return next;
}
