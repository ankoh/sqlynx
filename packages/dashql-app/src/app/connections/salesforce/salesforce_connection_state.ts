import * as connection from '@ankoh/dashql-jsonschema/connection.js';
import * as auth from '@ankoh/dashql-jsonschema/auth.js';

import type { DetailedError } from '../../../utils/error.js';

import { VariantKind } from '../../../utils/variant.js';
import { SalesforceDatabaseChannel } from './salesforce_api_client.js';
import { SALESFORCE_DATA_CLOUD_CONNECTOR } from '../connector_info.js';
import {
    ConnectionHealth,
    ConnectionState,
    ConnectionStatus,
    DELETE_CONNECTION,
    HEALTH_CHECK_CANCELLED,
    HEALTH_CHECK_FAILED,
    HEALTH_CHECK_STARTED,
    HEALTH_CHECK_SUCCEEDED,
    RESET_CONNECTION,
} from '../connection_state.js';
import { dateToTimestamp } from "../proto_helper.js";

/// The Salesforce connection state
export interface SalesforceConnectionStateDetails {
    /// The connection details
    proto: connection.SalesforceConnectionDetails;
    /// The Hyper connection
    channel: SalesforceDatabaseChannel | null;
}

/// Create the connection state details
export function createSalesforceConnectionStateDetails(params?: connection.SalesforceConnectionParams): SalesforceConnectionStateDetails {
    return {
        proto: {
            setupTimings: {},
            setupParams: params ?? { hyperProtocol: "V3_HTTP", instanceUrl: "", appConsumerKey: "", appConsumerSecret: "", login: "" }
        },
        channel: null
    };
}

/// Unpack the connection state from the variant
export function getSalesforceConnectionDetails(state: ConnectionState | null): SalesforceConnectionStateDetails | null {
    if (state == null) return null;
    switch (state.details.type) {
        case SALESFORCE_DATA_CLOUD_CONNECTOR: return state.details.value;
        default: return null;
    }
}

export const SETUP_CANCELLED = Symbol('AUTH_CANCELLED');
export const SETUP_FAILED = Symbol('AUTH_FAILED');
export const SETUP_STARTED = Symbol('AUTH_STARTED');

export const SF_CHANNEL_SETUP_CANCELLED = Symbol('SF_CHANNEL_SETUP_CANCELLED');
export const SF_CHANNEL_SETUP_FAILED = Symbol('SF_CHANNEL_SETUP_FAILED');
export const SF_CHANNEL_SETUP_STARTED = Symbol('SF_CHANNEL_SETUP_STARTED');
export const SF_CHANNEL_READY = Symbol('SF_CHANNEL_READY');

export const GENERATING_PKCE_CHALLENGE = Symbol('GENERATING_PKCE_CHALLENGE');
export const GENERATED_PKCE_CHALLENGE = Symbol('GENERATED_PKCE_CHALLENGE');
export const OAUTH_NATIVE_LINK_OPENED = Symbol('OAUTH_NATIVE_LINK_OPENED');
export const OAUTH_WEB_WINDOW_CLOSED = Symbol('OAUTH_WEB_WINDOW_CLOSED');
export const OAUTH_WEB_WINDOW_OPENED = Symbol('OAUTH_WEB_WINDOW_OPENED');
export const RECEIVED_CORE_AUTH_CODE = Symbol('RECEIVED_AUTH_CODE');
export const REQUESTING_CORE_AUTH_TOKEN = Symbol('REQUESTING_CORE_AUTH_TOKEN');
export const RECEIVED_CORE_AUTH_TOKEN = Symbol('RECEIVED_CORE_ACCESS_TOKEN');
export const RECEIVED_CORE_USER_INFO = Symbol('RECEIVED_CORE_USER_INFO');
export const REQUESTING_DATA_CLOUD_ACCESS_TOKEN = Symbol('REQUESTING_DATA_CLOUD_ACCESS_TOKEN');
export const RECEIVED_DATA_CLOUD_ACCESS_TOKEN = Symbol('RECEIVED_DATA_CLOUD_ACCESS_TOKEN');

export type SalesforceConnectionStateAction =
    | VariantKind<typeof SETUP_CANCELLED, DetailedError>
    | VariantKind<typeof SETUP_FAILED, DetailedError>
    | VariantKind<typeof SETUP_STARTED, connection.SalesforceConnectionParams>
    | VariantKind<typeof GENERATED_PKCE_CHALLENGE, auth.OAuthPKCEChallenge>
    | VariantKind<typeof GENERATING_PKCE_CHALLENGE, null>
    | VariantKind<typeof HEALTH_CHECK_CANCELLED, null>
    | VariantKind<typeof HEALTH_CHECK_FAILED, DetailedError>
    | VariantKind<typeof HEALTH_CHECK_STARTED, null>
    | VariantKind<typeof HEALTH_CHECK_SUCCEEDED, null>
    | VariantKind<typeof OAUTH_NATIVE_LINK_OPENED, null>
    | VariantKind<typeof OAUTH_WEB_WINDOW_CLOSED, null>
    | VariantKind<typeof OAUTH_WEB_WINDOW_OPENED, null>
    | VariantKind<typeof RECEIVED_CORE_AUTH_CODE, auth.TemporaryToken>
    | VariantKind<typeof RECEIVED_CORE_AUTH_TOKEN, connection.SalesforceCoreAccessToken>
    | VariantKind<typeof RECEIVED_CORE_USER_INFO, connection.SalesforceCoreUserInfo>
    | VariantKind<typeof RECEIVED_DATA_CLOUD_ACCESS_TOKEN, connection.SalesforceDataCloudAccessToken>
    | VariantKind<typeof REQUESTING_CORE_AUTH_TOKEN, null>
    | VariantKind<typeof REQUESTING_DATA_CLOUD_ACCESS_TOKEN, null>
    | VariantKind<typeof SF_CHANNEL_READY, SalesforceDatabaseChannel>
    | VariantKind<typeof SF_CHANNEL_SETUP_CANCELLED, DetailedError>
    | VariantKind<typeof SF_CHANNEL_SETUP_FAILED, DetailedError>
    | VariantKind<typeof SF_CHANNEL_SETUP_STARTED, connection.HyperConnectionParams>
    | VariantKind<typeof RESET_CONNECTION, null>
    | VariantKind<typeof DELETE_CONNECTION, null>
    ;

export function reduceSalesforceConnectionState(state: ConnectionState, action: SalesforceConnectionStateAction): ConnectionState | null {
    const details = state.details.value as SalesforceConnectionStateDetails;
    let next: ConnectionState | null = null;
    switch (action.type) {
        case DELETE_CONNECTION:
        case RESET_CONNECTION:
            details.channel?.close();
            next = {
                ...state,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {},
                            setupParams: details.proto.setupParams,
                            setupError: undefined,
                            channelError: undefined,
                            healthCheckError: undefined,
                        },
                        channel: null,
                    }
                },
            };
            break;
        case SETUP_STARTED: {
            const newDetails: SalesforceConnectionStateDetails = {
                proto: {
                    ...details.proto,
                    setupTimings: {
                        ...details.proto.setupTimings,
                        authStartedAt: dateToTimestamp(new Date()),
                    },
                    setupParams: action.value,
                    setupError: undefined,
                    channelError: undefined,
                    healthCheckError: undefined,
                    oauthState: {
                        oauthParams: {
                            instanceUrl: action.value.instanceUrl,
                            appConsumerKey: action.value.appConsumerKey,
                            requestedAt: Date.now(),
                            expiresAt: Date.now() + (2 * 60 * 60 * 1000), // 2 hours
                        },
                        oauthPkce: details.proto.oauthState?.oauthPkce ?? ({ value: "", verifier: "" } as auth.OAuthPKCEChallenge),
                        coreAuthCode: details.proto.oauthState?.coreAuthCode ?? ({ token: "", createdAt: new Date().toISOString() } as auth.TemporaryToken),
                        coreAccessToken: details.proto.oauthState?.coreAccessToken ?? ({} as connection.SalesforceCoreAccessToken),
                        dataCloudAccessToken: details.proto.oauthState?.dataCloudAccessToken ?? ({} as connection.SalesforceDataCloudAccessToken),
                    }
                },
                channel: null,
            };
            next = {
                ...state,
                connectionStatus: ConnectionStatus.AUTH_STARTED,
                connectionHealth: ConnectionHealth.CONNECTING,
                metrics: state.metrics,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: newDetails,
                },
            };
            break
        }
        case SETUP_CANCELLED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.AUTH_CANCELLED,
                connectionHealth: ConnectionHealth.CANCELLED,

                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                authCancelledAt: dateToTimestamp(new Date()),
                            },
                            setupError: action.value
                        },
                        channel: null,
                    }
                }
            };
            break;
        case SETUP_FAILED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.AUTH_FAILED,
                connectionHealth: ConnectionHealth.FAILED,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                authFailedAt: dateToTimestamp(new Date()),
                            },
                            setupError: action.value
                        },
                        channel: null,
                    }
                }
            };
            break;
        case GENERATING_PKCE_CHALLENGE:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.PKCE_GENERATION_STARTED,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                pkceGenStartedAt: dateToTimestamp(new Date()),
                            },
                        },
                        channel: null,
                    }
                }
            };
            break;
        case GENERATED_PKCE_CHALLENGE:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.PKCE_GENERATED,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                pkceGenFinishedAt: dateToTimestamp(new Date()),
                            },
                            oauthState: {
                                oauthParams: details.proto.oauthState?.oauthParams ?? { instanceUrl: "", appConsumerKey: "", requestedAt: Date.now(), expiresAt: Date.now() },
                                oauthPkce: action.value,
                                coreAuthCode: details.proto.oauthState?.coreAuthCode ?? ({ token: "", createdAt: new Date().toISOString() } as auth.TemporaryToken),
                                coreAccessToken: details.proto.oauthState?.coreAccessToken ?? ({} as connection.SalesforceCoreAccessToken),
                                dataCloudAccessToken: details.proto.oauthState?.dataCloudAccessToken ?? ({} as connection.SalesforceDataCloudAccessToken),
                            }
                        },
                    }
                }
            };
            break;
        case OAUTH_NATIVE_LINK_OPENED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.WAITING_FOR_OAUTH_CODE_VIA_LINK,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                openedNativeAuthLinkAt: dateToTimestamp(new Date()),
                            },
                        },
                    }
                }
            };
            break;
        case OAUTH_WEB_WINDOW_OPENED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.WAITING_FOR_OAUTH_CODE_VIA_WINDOW,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                openedWebAuthWindowAt: dateToTimestamp(new Date()),
                            },
                        },
                    }
                }
            };
            break;
        case OAUTH_WEB_WINDOW_CLOSED:
            next = {
                ...state,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                closedWebAuthWindowAt: dateToTimestamp(new Date()),
                            },
                        },
                    }
                }
            };
            break;
        case RECEIVED_CORE_AUTH_CODE:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.OAUTH_CODE_RECEIVED,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                oauthCodeReceivedAt: dateToTimestamp(new Date()),
                            },
                            oauthState: {
                                oauthParams: details.proto.oauthState?.oauthParams ?? { instanceUrl: "", appConsumerKey: "", requestedAt: Date.now(), expiresAt: Date.now() },
                                oauthPkce: details.proto.oauthState?.oauthPkce ?? ({ value: "", verifier: "" } as auth.OAuthPKCEChallenge),
                                coreAuthCode: action.value,
                                coreAccessToken: details.proto.oauthState?.coreAccessToken ?? ({} as connection.SalesforceCoreAccessToken),
                                dataCloudAccessToken: details.proto.oauthState?.dataCloudAccessToken ?? ({} as connection.SalesforceDataCloudAccessToken),
                            }
                        },
                    }
                }
            };
            break;
        case REQUESTING_CORE_AUTH_TOKEN:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.ACCESS_TOKEN_REQUESTED,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                coreAccessTokenRequestedAt: dateToTimestamp(new Date()),
                            },
                        },
                    }
                }
            };
            break;
        case RECEIVED_CORE_AUTH_TOKEN:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.CORE_ACCESS_TOKEN_RECEIVED,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                coreAccessTokenReceivedAt: dateToTimestamp(new Date()),
                            },
                            oauthState: {
                                oauthParams: details.proto.oauthState?.oauthParams ?? { instanceUrl: "", appConsumerKey: "", requestedAt: Date.now(), expiresAt: Date.now() },
                                oauthPkce: details.proto.oauthState?.oauthPkce ?? ({ value: "", verifier: "" } as auth.OAuthPKCEChallenge),
                                coreAuthCode: details.proto.oauthState?.coreAuthCode ?? ({ token: "", createdAt: new Date().toISOString() } as auth.TemporaryToken),
                                coreAccessToken: action.value,
                                dataCloudAccessToken: details.proto.oauthState?.dataCloudAccessToken ?? ({} as connection.SalesforceDataCloudAccessToken),
                            }
                        },
                    }
                }
            };
            break;
        case RECEIVED_CORE_USER_INFO: {
            // Persist the resolved account identity into setupParams.login so it is emitted as
            // the OAuth `login_hint` on subsequent connects and can be carried into shared
            // links/files. Resolving user info is best-effort (see salesforce_connection_setup):
            // if the connected app lacks the openid/profile scope we never reach this action.
            const resolvedLogin = action.value.preferredUsername ?? action.value.email ?? details.proto.setupParams?.login ?? "";
            next = {
                ...state,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupParams: details.proto.setupParams
                                ? { ...details.proto.setupParams, login: resolvedLogin }
                                : details.proto.setupParams,
                        },
                    }
                }
            };
            break;
        }
        case REQUESTING_DATA_CLOUD_ACCESS_TOKEN:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.DATA_CLOUD_TOKEN_REQUESTED,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                dataCloudAccessTokenRequestedAt: dateToTimestamp(new Date()),
                            },
                        },
                    }
                }
            };
            break;
        case RECEIVED_DATA_CLOUD_ACCESS_TOKEN:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.DATA_CLOUD_TOKEN_RECEIVED,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                dataCloudAccessTokenReceivedAt: dateToTimestamp(new Date()),
                            },
                            oauthState: {
                                oauthParams: details.proto.oauthState?.oauthParams ?? { instanceUrl: "", appConsumerKey: "", requestedAt: Date.now(), expiresAt: Date.now() },
                                oauthPkce: details.proto.oauthState?.oauthPkce ?? ({ value: "", verifier: "" } as auth.OAuthPKCEChallenge),
                                coreAuthCode: details.proto.oauthState?.coreAuthCode ?? ({ token: "", createdAt: new Date().toISOString() } as auth.TemporaryToken),
                                coreAccessToken: details.proto.oauthState?.coreAccessToken ?? ({} as connection.SalesforceCoreAccessToken),
                                dataCloudAccessToken: action.value,
                            }
                        },
                    }
                }
            };
            break;
        case SF_CHANNEL_SETUP_STARTED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.CHANNEL_SETUP_STARTED,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                channelSetupStartedAt: dateToTimestamp(new Date()),
                            },
                        },
                        channel: null,
                    }
                },
            };
            break;
        case SF_CHANNEL_SETUP_CANCELLED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.CHANNEL_SETUP_CANCELLED,
                connectionHealth: ConnectionHealth.CANCELLED,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                channelSetupCancelledAt: dateToTimestamp(new Date()),
                            },
                            channelError: action.value
                        },
                        channel: null
                    }
                },
            };
            break;
        case SF_CHANNEL_SETUP_FAILED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.CHANNEL_SETUP_FAILED,
                connectionHealth: ConnectionHealth.FAILED,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                channelSetupFailedAt: dateToTimestamp(new Date()),
                            },
                            channelError: action.value
                        },
                        channel: null
                    }
                },
            };
            break;
        case SF_CHANNEL_READY:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.CHANNEL_READY,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                channelReadyAt: dateToTimestamp(new Date()),
                            },
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
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        proto: {
                            ...details.proto,
                            setupTimings: {
                                ...details.proto.setupTimings,
                                healthCheckStartedAt: dateToTimestamp(new Date()),
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
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
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
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
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
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
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
