import * as sqlynx from '@ankoh/sqlynx-core';

import { PKCEChallenge } from '../utils/pkce.js';
import { VariantKind } from '../utils/variant.js';
import { SalesforceCoreAccessToken, SalesforceDataCloudAccessToken } from './salesforce_api_client.js';
import { SalesforceAuthParams } from './connection_params.js';
import { CONNECTOR_INFOS, ConnectorType, SALESFORCE_DATA_CLOUD_CONNECTOR } from './connector_info.js';
import {
    ConnectionHealth,
    ConnectionStatus,
    ConnectionState,
    ConnectionStateWithoutId,
    createConnectionState, RESET,
} from './connection_state.js';

export interface SalesforceAuthTimings {
    /// The time when the auth started
    authStartedAt: Date | null;
    /// The time when the auth got cancelled
    authCancelledAt: Date | null;
    /// The time when the auth failed
    authFailedAt: Date | null;
    /// The time when the PKCE generation started
    pkceGenStartedAt: Date | null;
    /// The time when the PKCE generation finished
    pkceGenFinishedAt: Date | null;
    /// The time when the auth link was opened
    openedNativeAuthLinkAt: Date | null;
    /// The time when the auth window was opened
    openedWebAuthWindowAt: Date | null;
    /// The time when the auth window was closed
    closedWebAuthWindowAt: Date | null;
    /// The time when we received the oauth code
    oauthCodeReceivedAt: Date | null;
    /// The time when we started to request the core access token
    coreAccessTokenRequestedAt: Date | null;
    /// The time when we received the core access token
    coreAccessTokenReceivedAt: Date | null;
    /// The time when we started to request the data cloud access token
    dataCloudAccessTokenRequestedAt: Date | null;
    /// The time when we received the data cloud access token
    dataCloudAccessTokenReceivedAt: Date | null;
}

export function createSalesforceAuthTimings(): SalesforceAuthTimings {
    return {
        authCancelledAt: null,
        authFailedAt: null,
        authStartedAt: null,
        pkceGenStartedAt: null,
        pkceGenFinishedAt: null,
        openedNativeAuthLinkAt: null,
        openedWebAuthWindowAt: null,
        closedWebAuthWindowAt: null,
        oauthCodeReceivedAt: null,
        coreAccessTokenRequestedAt: null,
        coreAccessTokenReceivedAt: null,
        dataCloudAccessTokenRequestedAt: null,
        dataCloudAccessTokenReceivedAt: null
    };
}

export interface SalesforceConnectionDetails {
    /// The timings
    authTimings: SalesforceAuthTimings;
    /// The auth params
    authParams: SalesforceAuthParams | null;
    /// The authentication error
    authError: string | null;
    /// The PKCE challenge
    pkceChallenge: PKCEChallenge | null;
    /// The popup window (if starting the OAuth flow from the browser)
    openAuthWindow: Window | null;
    /// The code
    coreAuthCode: string | null;
    /// The core access token
    coreAccessToken: SalesforceCoreAccessToken | null;
    /// The data cloud access token
    dataCloudAccessToken: SalesforceDataCloudAccessToken | null;
}

export function createSalesforceConnectorState(lnx: sqlynx.SQLynx): ConnectionStateWithoutId {
    return createConnectionState(lnx, CONNECTOR_INFOS[ConnectorType.SALESFORCE_DATA_CLOUD], {
        type: SALESFORCE_DATA_CLOUD_CONNECTOR,
        value: {
            authTimings: createSalesforceAuthTimings(),
            authParams: null,
            authError: null,
            pkceChallenge: null,
            openAuthWindow: null,
            coreAuthCode: null,
            coreAccessToken: null,
            dataCloudAccessToken: null,
        }
    });
}

export function getSalesforceConnectionDetails(state: ConnectionState | null): SalesforceConnectionDetails | null {
    if (state == null) return null;
    switch (state.details.type) {
        case SALESFORCE_DATA_CLOUD_CONNECTOR: return state.details.value;
        default: return null;
    }
}

export const AUTH_CANCELLED = Symbol('AUTH_CANCELLED');
export const AUTH_FAILED = Symbol('AUTH_FAILED');
export const AUTH_STARTED = Symbol('AUTH_STARTED');
export const GENERATING_PKCE_CHALLENGE = Symbol('GENERATING_PKCE_CHALLENGE');
export const GENERATED_PKCE_CHALLENGE = Symbol('GENERATED_PKCE_CHALLENGE');
export const OAUTH_NATIVE_LINK_OPENED = Symbol('OAUTH_NATIVE_LINK_OPENED');
export const OAUTH_WEB_WINDOW_CLOSED = Symbol('OAUTH_WEB_WINDOW_CLOSED');
export const OAUTH_WEB_WINDOW_OPENED = Symbol('OAUTH_WEB_WINDOW_OPENED');
export const RECEIVED_CORE_AUTH_CODE = Symbol('RECEIVED_AUTH_CODE');
export const REQUESTING_CORE_AUTH_TOKEN = Symbol('REQUESTING_CORE_AUTH_TOKEN');
export const RECEIVED_CORE_AUTH_TOKEN = Symbol('RECEIVED_CORE_ACCESS_TOKEN');
export const REQUESTING_DATA_CLOUD_ACCESS_TOKEN = Symbol('REQUESTING_DATA_CLOUD_ACCESS_TOKEN');
export const RECEIVED_DATA_CLOUD_ACCESS_TOKEN = Symbol('RECEIVED_DATA_CLOUD_ACCESS_TOKEN');

export type SalesforceConnectionStateAction =
    | VariantKind<typeof RESET, null>
    | VariantKind<typeof AUTH_STARTED, SalesforceAuthParams>
    | VariantKind<typeof AUTH_FAILED, string>
    | VariantKind<typeof AUTH_CANCELLED, string>
    | VariantKind<typeof GENERATING_PKCE_CHALLENGE, null>
    | VariantKind<typeof GENERATED_PKCE_CHALLENGE, PKCEChallenge>
    | VariantKind<typeof OAUTH_NATIVE_LINK_OPENED, null>
    | VariantKind<typeof OAUTH_WEB_WINDOW_OPENED, Window>
    | VariantKind<typeof OAUTH_WEB_WINDOW_CLOSED, null>
    | VariantKind<typeof RECEIVED_CORE_AUTH_CODE, string>
    | VariantKind<typeof REQUESTING_CORE_AUTH_TOKEN, null>
    | VariantKind<typeof RECEIVED_CORE_AUTH_TOKEN, SalesforceCoreAccessToken>
    | VariantKind<typeof REQUESTING_DATA_CLOUD_ACCESS_TOKEN, null>
    | VariantKind<typeof RECEIVED_DATA_CLOUD_ACCESS_TOKEN, SalesforceDataCloudAccessToken>;

export function reduceSalesforceConnectionState(state: ConnectionState, action: SalesforceConnectionStateAction): ConnectionState | null {
    const details = state.details.value as SalesforceConnectionDetails;
    let next: ConnectionState | null = null;
    switch (action.type) {
        case RESET:
            next = {
                ...state,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        authTimings: createSalesforceAuthTimings(),
                        authParams: details.authParams,
                        authError: null,
                        pkceChallenge: null,
                        openAuthWindow: null,
                        coreAuthCode: null,
                        coreAccessToken: null,
                        dataCloudAccessToken: null,
                    }
                }
            };
            break;
        case AUTH_STARTED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.AUTH_STARTED,
                connectionHealth: ConnectionHealth.CONNECTING,
                metrics: state.metrics,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        authTimings: {
                            ...createSalesforceAuthTimings(),
                            authStartedAt: new Date(),
                        },
                        authParams: action.value,
                        authError: null,
                        pkceChallenge: null,
                        openAuthWindow: null,
                        coreAuthCode: null,
                        coreAccessToken: null,
                        dataCloudAccessToken: null,
                    }
                }
            };
            break
        case AUTH_CANCELLED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.AUTH_CANCELLED,
                connectionHealth: ConnectionHealth.CANCELLED,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        authTimings: {
                            ...details.authTimings,
                            authCancelledAt: new Date(),
                        },
                        authError: action.value
                    }
                }
            };
            break;
        case AUTH_FAILED:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.AUTH_FAILED,
                connectionHealth: ConnectionHealth.FAILED,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        authTimings: {
                            ...details.authTimings,
                            authFailedAt: new Date(),
                        },
                        authError: action.value,
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
                        authTimings: {
                            ...details.authTimings,
                            pkceGenStartedAt: new Date(),
                        },
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
                        authTimings: {
                            ...details.authTimings,
                            pkceGenFinishedAt: new Date(),
                        },
                        pkceChallenge: action.value,
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
                        authTimings: {
                            ...details.authTimings,
                            openedNativeAuthLinkAt: new Date(),
                        },
                        openAuthWindow: null,
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
                        authTimings: {
                            ...details.authTimings,
                            openedWebAuthWindowAt: new Date(),
                        },
                        openAuthWindow: action.value,
                    }
                }
            };
            break;
        case OAUTH_WEB_WINDOW_CLOSED:
            if (!details.openAuthWindow) return state;
            next = {
                ...state,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        authTimings: {
                            ...details.authTimings,
                            closedWebAuthWindowAt: new Date(),
                        },
                        openAuthWindow: null,
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
                        authTimings: {
                            ...details.authTimings,
                            oauthCodeReceivedAt: new Date(),
                        },
                        coreAuthCode: action.value,
                    }
                }
            };
            break;
        case REQUESTING_CORE_AUTH_TOKEN:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.CORE_ACCESS_TOKEN_REQUESTED,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        authTimings: {
                            ...details.authTimings,
                            coreAccessTokenRequestedAt: new Date(),
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
                        authTimings: {
                            ...details.authTimings,
                            coreAccessTokenReceivedAt: new Date(),
                        },
                        coreAccessToken: action.value,
                    }
                }
            };
            break;
        case REQUESTING_DATA_CLOUD_ACCESS_TOKEN:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.DATA_CLOUD_TOKEN_REQUESTED,
                connectionHealth: ConnectionHealth.CONNECTING,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        authTimings: {
                            ...details.authTimings,
                            dataCloudAccessTokenRequestedAt: new Date(),
                        },
                    }
                }
            };
            break;
        case RECEIVED_DATA_CLOUD_ACCESS_TOKEN:
            next = {
                ...state,
                connectionStatus: ConnectionStatus.DATA_CLOUD_TOKEN_RECEIVED,
                connectionHealth: ConnectionHealth.ONLINE,
                details: {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        ...details,
                        authTimings: {
                            ...details.authTimings,
                            dataCloudAccessTokenReceivedAt: new Date(),
                        },
                        dataCloudAccessToken: action.value,
                    }
                }
            };
            break;
    }
    return next;
}
