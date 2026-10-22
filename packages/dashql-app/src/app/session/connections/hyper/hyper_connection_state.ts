import * as dashql from "@ankoh/dashql-core";

import * as connection from '@ankoh/dashql-jsonschema/connection.js';

import type { DetailedError } from '../connection_types.js';

import { VariantKind } from '../../../../utils/variant.js';
import { HyperDatabaseChannel } from './hyperdb_grpc_client.js';
import { ConnectorType, CONNECTOR_INFOS, HYPER_CONNECTOR } from '../connector_info.js';
import {
    ConnectionHealth,
    ConnectionStatus,
    AttachedDatabaseState,
    AttachedDatabaseStateWithoutId,
    createAttachedDatabaseState,
    HEALTH_CHECK_STARTED,
    HEALTH_CHECK_CANCELLED,
    HEALTH_CHECK_FAILED,
    HEALTH_CHECK_SUCCEEDED,
    RESET_ATTACHED_DATABASE,
    DELETE_ATTACHED_DATABASE,
} from '../attached_database_state.js';
import { Hasher } from "../../../../utils/hash.js";
import { ConnectionSignatureMap, updateConnectionSignature } from "../connection_signature.js";
import { DefaultHasher } from "../../../../utils/hash_default.js";
import { dateToTimestamp } from "../proto_helper.js";
import { StorageWriter } from "../../../storage/storage_writer.js";

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

export function createHyperConnectionState(dql: dashql.DashQL, connSigs: ConnectionSignatureMap): AttachedDatabaseStateWithoutId {
    return createAttachedDatabaseState(dql, CONNECTOR_INFOS[ConnectorType.HYPER], connSigs, {
        type: HYPER_CONNECTOR,
        value: createHyperConnectionStateDetails()
    });
}

export function getHyperConnectionDetails(state: AttachedDatabaseState | null): HyperConnectionDetails | null {
    if (state == null) return null;
    switch (state.details.type) {
        case HYPER_CONNECTOR: return state.details.value;
        default: return null;
    }
}

export function computeHyperConnectionSignature(details: HyperConnectionDetails, hasher: Hasher) {
    hasher.add("hyper");
    hasher.add(details.proto.setupParams?.protocol ?? "");
    hasher.add(details.proto.setupParams?.endpoint ?? "");
    const databases = [...(details.proto.setupParams?.attachedDatabases ?? [])]
        .map(database => `${database.path}\0${database.alias}`)
        .sort();
    for (const database of databases) hasher.add(database);
}

export const HYPER_CHANNEL_SETUP_CANCELLED = Symbol('HYPER_CHANNEL_SETUP_CANCELLED');
export const HYPER_CHANNEL_SETUP_FAILED = Symbol('HYPER_CHANNEL_SETUP_FAILED');
export const HYPER_CHANNEL_SETUP_STARTED = Symbol('HYPER_CHANNEL_SETUP_STARTED');
export const HYPER_CHANNEL_READY = Symbol('HYPER_CHANNEL_READY');

export type HyperConnectorAction =
    | VariantKind<typeof RESET_ATTACHED_DATABASE, null>
    | VariantKind<typeof DELETE_ATTACHED_DATABASE, null>
    | VariantKind<typeof HYPER_CHANNEL_SETUP_STARTED, connection.HyperConnectionParams>
    | VariantKind<typeof HYPER_CHANNEL_SETUP_CANCELLED, DetailedError>
    | VariantKind<typeof HYPER_CHANNEL_SETUP_FAILED, DetailedError>
    | VariantKind<typeof HYPER_CHANNEL_READY, [HyperDatabaseChannel, connection.HyperConnectionParams]>
    | VariantKind<typeof HEALTH_CHECK_STARTED, null>
    | VariantKind<typeof HEALTH_CHECK_CANCELLED, null>
    | VariantKind<typeof HEALTH_CHECK_FAILED, DetailedError>
    | VariantKind<typeof HEALTH_CHECK_SUCCEEDED, null>
    ;

export function reduceHyperConnectorState(state: AttachedDatabaseState, action: HyperConnectorAction, _storage: StorageWriter): AttachedDatabaseState | null {
    const details = state.details.value as HyperConnectionDetails;
    let next: AttachedDatabaseState | null = null;
    switch (action.type) {
        case DELETE_ATTACHED_DATABASE:
        case RESET_ATTACHED_DATABASE:
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
            const sig = new DefaultHasher();
            computeHyperConnectionSignature(details, sig);
            next = {
                ...state,
                connectionStatus: ConnectionStatus.CHANNEL_SETUP_STARTED,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: HYPER_CONNECTOR,
                    value: details,
                },
                connectionSignature: updateConnectionSignature(state.connectionSignature, sig, state.databaseId),
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
