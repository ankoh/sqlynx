import * as connection from '@ankoh/dashql-jsonschema/connection.js';

import type { DetailedError } from '../../../utils/error.js';

import { VariantKind } from '../../../utils/variant.js';
import { HyperDatabaseChannel } from './hyperdb_grpc_client.js';
import { HYPER_CONNECTOR } from '../connector_info.js';
import {
    ConnectionHealth,
    ConnectionStatus,
    ConnectionState,
    HEALTH_CHECK_STARTED,
    HEALTH_CHECK_CANCELLED,
    HEALTH_CHECK_FAILED,
    HEALTH_CHECK_SUCCEEDED,
    RESET_CONNECTION,
    DELETE_CONNECTION,
} from '../connection_state.js';
import { dateToTimestamp } from "../proto_helper.js";

export interface HyperConnectionDetails {
    /// The protobuf
    proto: connection.HyperConnectionDetails;
    /// The hyper channel
    channel: HyperDatabaseChannel | null;
}

export function createHyperConnectionStateDetails(params?: connection.HyperConnectionParams): HyperConnectionDetails {
    return {
        proto: {
            setupTimings: {},
            setupParams: params ?? {
                protocol: "WASM",
                endpoint: "",
                tls: {
                    clientKeyPath: "",
                    clientCertPath: "",
                    caCertsPath: ""
                }
            },
        },
        channel: null
    };
}

export function getHyperConnectionDetails(state: ConnectionState | null): HyperConnectionDetails | null {
    if (state == null) return null;
    switch (state.details.type) {
        case HYPER_CONNECTOR: return state.details.value;
        default: return null;
    }
}

export const HYPER_CHANNEL_SETUP_CANCELLED = Symbol('HYPER_CHANNEL_SETUP_CANCELLED');
export const HYPER_CHANNEL_SETUP_FAILED = Symbol('HYPER_CHANNEL_SETUP_FAILED');
export const HYPER_CHANNEL_SETUP_STARTED = Symbol('HYPER_CHANNEL_SETUP_STARTED');
export const HYPER_CHANNEL_READY = Symbol('HYPER_CHANNEL_READY');

export type HyperConnectorAction =
    | VariantKind<typeof RESET_CONNECTION, null>
    | VariantKind<typeof DELETE_CONNECTION, null>
    | VariantKind<typeof HYPER_CHANNEL_SETUP_STARTED, connection.HyperConnectionParams>
    | VariantKind<typeof HYPER_CHANNEL_SETUP_CANCELLED, DetailedError>
    | VariantKind<typeof HYPER_CHANNEL_SETUP_FAILED, DetailedError>
    | VariantKind<typeof HYPER_CHANNEL_READY, [HyperDatabaseChannel, connection.HyperConnectionParams]>
    | VariantKind<typeof HEALTH_CHECK_STARTED, null>
    | VariantKind<typeof HEALTH_CHECK_CANCELLED, null>
    | VariantKind<typeof HEALTH_CHECK_FAILED, DetailedError>
    | VariantKind<typeof HEALTH_CHECK_SUCCEEDED, null>
    ;

export function reduceHyperConnectorState(state: ConnectionState, action: HyperConnectorAction): ConnectionState | null {
    const details = state.details.value as HyperConnectionDetails;
    let next: ConnectionState | null = null;
    switch (action.type) {
        case DELETE_CONNECTION:
        case RESET_CONNECTION:
            details.channel?.close();
            next = {
                ...state,
                details: {
                    type: HYPER_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {},
                            channelError: undefined,
                            healthCheckError: undefined,
                        },
                        channel: null
                    }
                },
            };
            break;
        case HYPER_CHANNEL_SETUP_CANCELLED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.CHANNEL_SETUP_CANCELLED,
                connectionHealth: ConnectionHealth.CANCELLED,
                details: {
                    type: HYPER_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                channelSetupCancelledAt: dateToTimestamp(new Date()),
                            },
                            setupParams: details.proto.setupParams,
                            channelError: action.value,
                            healthCheckError: undefined,
                        },
                        channel: null
                    }
                },
            };
            break;
        case HYPER_CHANNEL_SETUP_FAILED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.CHANNEL_SETUP_FAILED,
                connectionHealth: ConnectionHealth.FAILED,
                details: {
                    type: HYPER_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                channelSetupFailedAt: dateToTimestamp(new Date()),
                            },
                            channelError: action.value,
                        },
                        channel: null
                    }
                },
            };
            break;
        case HYPER_CHANNEL_SETUP_STARTED: {
            const details: HyperConnectionDetails = {
                proto: {
                    setupTimings: {
                        channelSetupStartedAt: dateToTimestamp(new Date()),
                    },
                    setupParams: action.value,
                    channelError: undefined,
                    healthCheckError: undefined,
                },
                channel: null,
            };
            next = {
                ...state,
                connectionStatus: ConnectionStatus.CHANNEL_SETUP_STARTED,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: HYPER_CONNECTOR,
                    value: details,
                },
            };
            break;
        }
        case HYPER_CHANNEL_READY:
            const [channel, setupParams] = action.value;
            next = {
                ...state,
                connectionStatus: ConnectionStatus.CHANNEL_READY,
                connectionHealth: setupParams.protocol === 'WASM'
                    ? ConnectionHealth.ONLINE
                    : ConnectionHealth.CONNECTING,
                details: {
                    type: HYPER_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupParams,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                channelReadyAt: dateToTimestamp(new Date()),
                            },
                        },
                        channel,
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
                    type: HYPER_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                healthCheckStartedAt: dateToTimestamp(new Date()),
                            },
                        },
                    },

                },
            };
            break;
        case HEALTH_CHECK_FAILED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.HEALTH_CHECK_FAILED,
                connectionHealth: ConnectionHealth.FAILED,
                details: {
                    type: HYPER_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                healthCheckFailedAt: dateToTimestamp(new Date()),
                            },
                            healthCheckError: action.value,
                        },
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
                    type: HYPER_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                healthCheckCancelledAt: dateToTimestamp(new Date()),
                            },
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
                    type: HYPER_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                healthCheckSucceededAt: dateToTimestamp(new Date()),
                            },
                        },
                    }
                },
            };
            break;
    }
    return next;
}
