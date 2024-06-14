import * as sqlynx from "@ankoh/sqlynx-core";

import { VariantKind } from '../utils/variant.js';
import { HyperGrpcConnectionParams } from './connection_params.js';
import { HyperDatabaseChannel } from '../platform/hyperdb_client.js';
import { CONNECTOR_INFOS, ConnectorType, HYPER_GRPC_CONNECTOR } from './connector_info.js';
import {
    ConnectionHealth,
    ConnectionStatus,
    ConnectionState,
    ConnectionStateWithoutId,
    createConnectionState,
    RESET,
} from './connection_state.js';

export interface HyperGrpcSetupTimings {
    /// The time when the channel setup started
    channelSetupStartedAt: Date | null;
    /// The time when the channel setup got cancelled
    channelSetupCancelledAt: Date | null;
    /// The time when the channel setup failed
    channelSetupFailedAt: Date | null;
    /// The time when the channel was marked ready
    channelReadyAt: Date | null;
    /// The time when the health check started
    healthCheckStartedAt: Date | null;
    /// The time when the health check got cancelled
    healthCheckCancelledAt: Date | null;
    /// The time when the health check failed
    healthCheckFailedAt: Date | null;
    /// The time when the health check succeeded
    healthCheckSucceededAt: Date | null;
}

export interface HyperGrpcConnectionDetails {
    /// The setup timings
    setupTimings: HyperGrpcSetupTimings;
    /// The auth params
    channelSetupParams: HyperGrpcConnectionParams | null;
    /// The authentication error
    channelError: string | null;
    /// The Hyper connection
    channel: HyperDatabaseChannel | null;
    /// The health check error
    healthCheckError: string | null;
}

export function createHyperGrpcConnectionState(lnx: sqlynx.SQLynx): ConnectionStateWithoutId {
    return createConnectionState(lnx, CONNECTOR_INFOS[ConnectorType.HYPER_GRPC], {
        type: HYPER_GRPC_CONNECTOR,
        value: {
            setupTimings: {
                channelSetupStartedAt: null,
                channelSetupCancelledAt: null,
                channelSetupFailedAt: null,
                channelReadyAt: null,
                healthCheckStartedAt: null,
                healthCheckCancelledAt: null,
                healthCheckFailedAt: null,
                healthCheckSucceededAt: null,
            },
            channelSetupParams: null,
            channelError: null,
            channel: null,
            healthCheckError: null,
        }
    });
}

export function getHyperGrpcConnectionDetails(state: ConnectionState | null): HyperGrpcConnectionDetails | null {
    if (state == null) return null;
    switch (state.details.type) {
        case HYPER_GRPC_CONNECTOR: return state.details.value;
        default: return null;
    }
}

export const CHANNEL_SETUP_CANCELLED = Symbol('CHANNEL_SETUP_CANCELLED');
export const CHANNEL_SETUP_FAILED = Symbol('CHANNEL_SETUP_FAILED');
export const CHANNEL_SETUP_STARTED = Symbol('CHANNEL_SETUP_STARTED');
export const CHANNEL_READY = Symbol('CHANNEL_READY');
export const HEALTH_CHECK_STARTED = Symbol('HEALTH_CHECK_STARTED');
export const HEALTH_CHECK_CANCELLED = Symbol('HEALTH_CHECK_CANCELLED');
export const HEALTH_CHECK_SUCCEEDED = Symbol('HEALTH_CHECK_SUCCEEDED');
export const HEALTH_CHECK_FAILED = Symbol('HEALTH_CHECK_FAILED');

export type HyperGrpcConnectorAction =
    | VariantKind<typeof RESET, null>
    | VariantKind<typeof CHANNEL_SETUP_STARTED, HyperGrpcConnectionParams>
    | VariantKind<typeof CHANNEL_SETUP_CANCELLED, string>
    | VariantKind<typeof CHANNEL_SETUP_FAILED, string>
    | VariantKind<typeof CHANNEL_READY, HyperDatabaseChannel>
    | VariantKind<typeof HEALTH_CHECK_STARTED, null>
    | VariantKind<typeof HEALTH_CHECK_CANCELLED, null>
    | VariantKind<typeof HEALTH_CHECK_FAILED, string>
    | VariantKind<typeof HEALTH_CHECK_SUCCEEDED, null>
    ;

export function reduceHyperGrpcConnectorState(state: ConnectionState, action: HyperGrpcConnectorAction): ConnectionState | null {
    const details = state.details.value as HyperGrpcConnectionDetails;
    let next: ConnectionState | null = null;
    switch (action.type) {
        case RESET:
            if (details.channel) {
                details.channel.close();
            }
            next = {
                ...state,
                details: {
                    type: HYPER_GRPC_CONNECTOR,
                    value: {
                        ...details,
                        setupTimings: {
                            channelSetupStartedAt: new Date(),
                            channelSetupCancelledAt: null,
                            channelSetupFailedAt: null,
                            channelReadyAt: null,
                            healthCheckStartedAt: null,
                            healthCheckCancelledAt: null,
                            healthCheckFailedAt: null,
                            healthCheckSucceededAt: null,
                        },
                        channelSetupParams: details.channelSetupParams,
                        channelError: null,
                        channel: null,
                        healthCheckError: null,
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
                    type: HYPER_GRPC_CONNECTOR,
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
                    type: HYPER_GRPC_CONNECTOR,
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
                    type: HYPER_GRPC_CONNECTOR,
                    value: {
                        ...details,
                        setupTimings: {
                            channelSetupStartedAt: new Date(),
                            channelSetupCancelledAt: null,
                            channelSetupFailedAt: null,
                            channelReadyAt: null,
                            healthCheckStartedAt: null,
                            healthCheckCancelledAt: null,
                            healthCheckFailedAt: null,
                            healthCheckSucceededAt: null,
                        },
                        channelSetupParams: action.value,
                        channelError: null,
                        channel: null,
                        healthCheckError: null,
                    }
                },
            };
            break;
        case CHANNEL_READY:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.CHANNEL_READY,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: HYPER_GRPC_CONNECTOR,
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
        case HEALTH_CHECK_STARTED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.HEALTH_CHECK_STARTED,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: HYPER_GRPC_CONNECTOR,
                    value: {
                        ...details,
                        setupTimings: {
                            ...details.setupTimings,
                            healthCheckStartedAt: new Date(),
                        },
                    }
                },
            };
            break;
        case HEALTH_CHECK_FAILED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.HEALTH_CHECK_FAILED,
                connectionHealth: ConnectionHealth.FAILED,
                details: {
                    type: HYPER_GRPC_CONNECTOR,
                    value: {
                        ...details,
                        setupTimings: {
                            ...details.setupTimings,
                            healthCheckFailedAt: new Date(),
                        },
                        healthCheckError: action.value,
                    }
                },
            };
            break;
        case HEALTH_CHECK_CANCELLED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.HEALTH_CHECK_CANCELLED,
                connectionHealth: ConnectionHealth.CANCELLED,
                details: {
                    type: HYPER_GRPC_CONNECTOR,
                    value: {
                        ...details,
                        setupTimings: {
                            ...details.setupTimings,
                            healthCheckCancelledAt: new Date(),
                        },
                    }
                },
            };
            break;
        case HEALTH_CHECK_SUCCEEDED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.HEALTH_CHECK_SUCCEEDED,
                connectionHealth: ConnectionHealth.ONLINE,
                details: {
                    type: HYPER_GRPC_CONNECTOR,
                    value: {
                        ...details,
                        setupTimings: {
                            ...details.setupTimings,
                            healthCheckSucceededAt: new Date(),
                        },
                    }
                },
            };
            break;
    }
    return next;
}
