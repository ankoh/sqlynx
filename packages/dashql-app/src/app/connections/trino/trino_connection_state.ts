import * as connection from '@ankoh/dashql-jsonschema/connection.js';
import * as auth from '@ankoh/dashql-jsonschema/auth.js';

import type { DetailedError } from '../../../utils/error.js';

import { VariantKind } from '../../../utils/variant.js';
import { TRINO_CONNECTOR } from '../connector_info.js';
import {
    ConnectionHealth,
    ConnectionStatus,
    ConnectionState,
    HEALTH_CHECK_CANCELLED,
    HEALTH_CHECK_FAILED,
    HEALTH_CHECK_STARTED,
    HEALTH_CHECK_SUCCEEDED,
    RESET_CONNECTION,
    DELETE_CONNECTION,
} from '../connection_state.js';
import { TrinoChannelInterface } from "./trino_channel.js";
import { dateToTimestamp } from "../proto_helper.js";

// OAuth flow action symbols
export const OAUTH_STARTED = Symbol('OAUTH_STARTED');
export const OAUTH_CANCELLED = Symbol('OAUTH_CANCELLED');
export const OAUTH_FAILED = Symbol('OAUTH_FAILED');
export const GENERATING_PKCE_CHALLENGE = Symbol('GENERATING_PKCE_CHALLENGE');
export const GENERATED_PKCE_CHALLENGE = Symbol('GENERATED_PKCE_CHALLENGE');
export const OAUTH_BROWSER_OPENED = Symbol('OAUTH_BROWSER_OPENED');
export const RECEIVED_OAUTH_CODE = Symbol('RECEIVED_OAUTH_CODE');
export const REQUESTING_ACCESS_TOKEN = Symbol('REQUESTING_ACCESS_TOKEN');
export const RECEIVED_ACCESS_TOKEN = Symbol('RECEIVED_ACCESS_TOKEN');

export interface TrinoConnectionStateDetails {
    /// The proto
    proto: connection.TrinoConnectionDetails;
    /// The channel
    channel: TrinoChannelInterface | null;
}

export function createTrinoConnectionStateDetails(params?: connection.TrinoConnectionParams): TrinoConnectionStateDetails {
    return {
        proto: {
            setupTimings: {},
            setupParams: params ?? { endpoint: "", auth: { authType: "AUTH_BASIC" }, catalogName: "" },
        },
        channel: null
    };
}

export function getTrinoConnectionDetails(state: ConnectionState | null): TrinoConnectionStateDetails | null {
    if (state == null) return null;
    switch (state.details.type) {
        case TRINO_CONNECTOR: return state.details.value;
        default: return null;
    }
}

export const TRINO_CHANNEL_SETUP_CANCELLED = Symbol('TRINO_CHANNEL_SETUP_CANCELLED');
export const TRINO_CHANNEL_SETUP_FAILED = Symbol('TRINO_CHANNEL_SETUP_FAILED');
export const TRINO_CHANNEL_SETUP_STARTED = Symbol('TRINO_CHANNEL_SETUP_STARTED');
export const TRINO_CHANNEL_READY = Symbol('TRINO_CHANNEL_READY');

export type TrinoConnectorAction =
    | VariantKind<typeof RESET_CONNECTION, null>
    | VariantKind<typeof DELETE_CONNECTION, null>
    // OAuth flow actions
    | VariantKind<typeof OAUTH_STARTED, connection.TrinoConnectionParams>
    | VariantKind<typeof OAUTH_CANCELLED, DetailedError>
    | VariantKind<typeof OAUTH_FAILED, DetailedError>
    | VariantKind<typeof GENERATING_PKCE_CHALLENGE, null>
    | VariantKind<typeof GENERATED_PKCE_CHALLENGE, auth.OAuthPKCEChallenge>
    | VariantKind<typeof OAUTH_BROWSER_OPENED, null>
    | VariantKind<typeof RECEIVED_OAUTH_CODE, auth.TemporaryToken>
    | VariantKind<typeof REQUESTING_ACCESS_TOKEN, null>
    | VariantKind<typeof RECEIVED_ACCESS_TOKEN, connection.TrinoAccessToken>
    // Channel setup actions
    | VariantKind<typeof TRINO_CHANNEL_SETUP_STARTED, connection.TrinoConnectionParams>
    | VariantKind<typeof TRINO_CHANNEL_SETUP_CANCELLED, DetailedError>
    | VariantKind<typeof TRINO_CHANNEL_SETUP_FAILED, DetailedError>
    | VariantKind<typeof TRINO_CHANNEL_READY, TrinoChannelInterface>
    // Health check actions
    | VariantKind<typeof HEALTH_CHECK_CANCELLED, DetailedError>
    | VariantKind<typeof HEALTH_CHECK_FAILED, DetailedError>
    | VariantKind<typeof HEALTH_CHECK_STARTED, null>
    | VariantKind<typeof HEALTH_CHECK_SUCCEEDED, null>
    ;

export function reduceTrinoConnectorState(state: ConnectionState, action: TrinoConnectorAction): ConnectionState | null {
    const details = state.details.value as TrinoConnectionStateDetails;
    let next: ConnectionState | null = null;
    switch (action.type) {
        case DELETE_CONNECTION:
        case RESET_CONNECTION:
            details.channel?.close();
            next = {
                ...state,
                details: {
                    type: TRINO_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {},
                            channelError: undefined,
                            healthCheckError: undefined,
                            oauthState: undefined,
                        },
                        channel: null
                    }
                },
            };
            break;

        // OAuth flow actions
        case OAUTH_STARTED: {
            const newDetails: TrinoConnectionStateDetails = {
                proto: {
                    ...details.proto,
                    setupTimings: {
                        oauthStartedAt: dateToTimestamp(new Date()),
                    },
                    setupParams: action.value,
                    channelError: undefined,
                    healthCheckError: undefined,
                    oauthState: {
                        oauthPkce: { value: "", verifier: "" } as auth.OAuthPKCEChallenge,
                        authCode: { token: "", createdAt: new Date().toISOString() } as auth.TemporaryToken,
                        accessToken: {} as connection.TrinoAccessToken,
                    },
                },
                channel: null,
            };
            next = {
                ...state,
                connectionStatus: ConnectionStatus.AUTH_STARTED,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: TRINO_CONNECTOR,
                    value: newDetails,
                },
            };
            break;
        }
        case OAUTH_CANCELLED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.AUTH_CANCELLED,
                connectionHealth: ConnectionHealth.CANCELLED,
                details: {
                    type: TRINO_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                oauthCancelledAt: dateToTimestamp(new Date())
                            },
                        },
                        channel: null,
                    }
                },
            };
            break;
        case OAUTH_FAILED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.AUTH_FAILED,
                connectionHealth: ConnectionHealth.FAILED,
                details: {
                    type: TRINO_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                oauthFailedAt: dateToTimestamp(new Date())
                            },
                            channelError: action.value,
                        },
                        channel: null,
                    }
                },
            };
            break;
        case GENERATING_PKCE_CHALLENGE:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.PKCE_GENERATION_STARTED,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: TRINO_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                pkceGenStartedAt: dateToTimestamp(new Date())
                            },
                        },
                    }
                },
            };
            break;
        case GENERATED_PKCE_CHALLENGE:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.PKCE_GENERATED,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: TRINO_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                pkceGenFinishedAt: dateToTimestamp(new Date())
                            },
                            oauthState: {
                                oauthPkce: action.value,
                                authCode: details.proto.oauthState?.authCode ?? ({ token: "", createdAt: new Date().toISOString() } as auth.TemporaryToken),
                                accessToken: details.proto.oauthState?.accessToken ?? ({} as connection.TrinoAccessToken),
                            },
                        },
                    }
                },
            };
            break;
        case OAUTH_BROWSER_OPENED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.WAITING_FOR_OAUTH_CODE_VIA_LINK,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: TRINO_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                oauthBrowserOpenedAt: dateToTimestamp(new Date())
                            },
                        },
                    }
                },
            };
            break;
        case RECEIVED_OAUTH_CODE:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.OAUTH_CODE_RECEIVED,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: TRINO_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                oauthCodeReceivedAt: dateToTimestamp(new Date())
                            },
                            oauthState: {
                                oauthPkce: details.proto.oauthState?.oauthPkce ?? ({ value: "", verifier: "" } as auth.OAuthPKCEChallenge),
                                authCode: action.value,
                                accessToken: details.proto.oauthState?.accessToken ?? ({} as connection.TrinoAccessToken),
                            },
                        },
                    }
                },
            };
            break;
        case REQUESTING_ACCESS_TOKEN:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.ACCESS_TOKEN_REQUESTED,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: TRINO_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                accessTokenRequestedAt: dateToTimestamp(new Date())
                            },
                        },
                    }
                },
            };
            break;
        case RECEIVED_ACCESS_TOKEN:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.ACCESS_TOKEN_RECEIVED,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: TRINO_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                accessTokenReceivedAt: dateToTimestamp(new Date())
                            },
                            oauthState: {
                                oauthPkce: details.proto.oauthState?.oauthPkce ?? ({ value: "", verifier: "" } as auth.OAuthPKCEChallenge),
                                authCode: details.proto.oauthState?.authCode ?? ({ token: "", createdAt: new Date().toISOString() } as auth.TemporaryToken),
                                accessToken: action.value,
                            },
                        },
                    }
                },
            };
            break;

        // Channel setup actions
        case TRINO_CHANNEL_SETUP_CANCELLED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.CHANNEL_SETUP_CANCELLED,
                connectionHealth: ConnectionHealth.CANCELLED,
                details: {
                    type: TRINO_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                channelSetupCancelledAt: dateToTimestamp(new Date())
                            },
                        },
                        channel: null
                    }
                },
            };
            break;
        case TRINO_CHANNEL_SETUP_STARTED: {
            const newDetails: TrinoConnectionStateDetails = {
                ...details,
                proto: {
                    ...details.proto,
                    setupTimings: {
                        ...details.proto.setupTimings,
                        channelSetupStartedAt: dateToTimestamp(new Date())
                    },
                    setupParams: action.value,
                    channelError: undefined,
                    schemaResolutionError: undefined,
                    healthCheckError: undefined,
                },
                channel: null
            };
            next = {
                ...state,
                connectionStatus: ConnectionStatus.CHANNEL_SETUP_STARTED,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: TRINO_CONNECTOR,
                    value: newDetails,
                },
            };
            break;
        }
        case TRINO_CHANNEL_SETUP_FAILED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.CHANNEL_SETUP_FAILED,
                connectionHealth: ConnectionHealth.FAILED,
                details: {
                    type: TRINO_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                channelSetupFailedAt: dateToTimestamp(new Date())
                            },
                            channelError: action.value,
                        },
                        channel: null
                    }
                },
            };
            break;
        case TRINO_CHANNEL_READY:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.CHANNEL_READY,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: TRINO_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                channelReadyAt: dateToTimestamp(new Date())
                            },
                        },
                        channel: action.value
                    }
                },
            };
            break;

        // Health check actions
        case HEALTH_CHECK_STARTED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.HEALTH_CHECK_STARTED,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: TRINO_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                healthCheckStartedAt: dateToTimestamp(new Date())
                            },
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
                    type: TRINO_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                healthCheckFailedAt: dateToTimestamp(new Date())
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
                    type: TRINO_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                healthCheckCancelledAt: dateToTimestamp(new Date())
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
                    type: TRINO_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                healthCheckSucceededAt: dateToTimestamp(new Date())
                            },
                        },
                    }
                },
            };
            break;
    }
    return next;
}
