import { VariantKind } from '../utils/variant.js';
import { HyperGrpcConnectionParams } from './connection_params.js';
import { HyperDatabaseChannel } from '../platform/hyperdb_client.js';

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
}

export interface HyperGrpcConnectionState {
    /// The setup timings
    setupTimings: HyperGrpcSetupTimings;
    /// The auth params
    channelSetupParams: HyperGrpcConnectionParams | null;
    /// The authentication error
    connectionError: string | null;
    /// The Hyper connection
    connection: HyperDatabaseChannel | null;
}

export function createHyperGrpcConnectionState(): HyperGrpcConnectionState {
    return {
        setupTimings: {
            channelSetupCancelledAt: null,
            channelSetupFailedAt: null,
            channelSetupStartedAt: null,
            channelReadyAt: null,
            healthCheckCancelledAt: null,
            healthCheckFailedAt: null,
            healthCheckStartedAt: null,
        },
        channelSetupParams: null,
        connectionError: null,
        connection: null,
    }
}

export const RESET = Symbol('RESET');
export const CHANNEL_SETUP_CANCELLED = Symbol('CHANNEL_SETUP_CANCELLED');
export const CHANNEL_SETUP_FAILED = Symbol('CHANNEL_SETUP_FAILED');
export const CHANNEL_SETUP_STARTED = Symbol('CHANNEL_SETUP_STARTED');
export const CHANNEL_READY = Symbol('CHANNEL_READY');
export const HEALTH_CHECK_STARTED = Symbol('HEALTH_CHECK_STARTED');
export const HEALTH_CHECK_FAILED = Symbol('HEALTH_CHECK_FAILED');
export const HEALTH_CHECK_CANCELLED = Symbol('HEALTH_CHECK_CANCELLED');
export const HEALTH_CHECK_SUCCEEDED = Symbol('HEALTH_CHECK_SUCCEEDED');

export type HyperGrpcConnectorAction =
    | VariantKind<typeof RESET, null>
    | VariantKind<typeof CHANNEL_SETUP_STARTED, HyperGrpcConnectionParams>
    | VariantKind<typeof CHANNEL_SETUP_FAILED, string>
    | VariantKind<typeof CHANNEL_SETUP_CANCELLED, string>
    | VariantKind<typeof CHANNEL_READY, HyperDatabaseChannel>
    | VariantKind<typeof HEALTH_CHECK_STARTED, void>
    | VariantKind<typeof HEALTH_CHECK_FAILED, string>
    | VariantKind<typeof HEALTH_CHECK_CANCELLED, string>
    | VariantKind<typeof HEALTH_CHECK_SUCCEEDED, string>
    ;

export function reduceAuthState(state: HyperGrpcConnectionState, action: HyperGrpcConnectorAction): HyperGrpcConnectionState {
    switch (action.type) {
        case RESET:
            return {
                setupTimings: {
                    channelSetupStartedAt: new Date(),
                    channelSetupCancelledAt: null,
                    channelSetupFailedAt: null,
                    channelReadyAt: null,
                    healthCheckStartedAt: null,
                    healthCheckCancelledAt: null,
                    healthCheckFailedAt: null,
                },
                channelSetupParams: state.channelSetupParams,
                connectionError: null,
                connection: null,
            };
        case CHANNEL_SETUP_STARTED:
            return {
                setupTimings: {
                    channelSetupStartedAt: new Date(),
                    channelSetupCancelledAt: null,
                    channelSetupFailedAt: null,
                    channelReadyAt: null,
                    healthCheckStartedAt: null,
                    healthCheckCancelledAt: null,
                    healthCheckFailedAt: null,
                },
                channelSetupParams: action.value,
                connectionError: null,
                connection: null,
            };
        case CHANNEL_SETUP_CANCELLED:
            return {
                ...state,
                setupTimings: {
                    ...state.setupTimings,
                    channelSetupCancelledAt: new Date(),
                },
                connectionError: action.value,
                connection: null
            };
        case CHANNEL_SETUP_FAILED:
            return {
                ...state,
                setupTimings: {
                    ...state.setupTimings,
                    channelSetupFailedAt: new Date(),
                },
                connectionError: action.value,
                connection: null
            };

        case CHANNEL_READY:
        case HEALTH_CHECK_STARTED:
        case HEALTH_CHECK_FAILED:
        case HEALTH_CHECK_CANCELLED:
        case HEALTH_CHECK_SUCCEEDED:
            return state;
    }
}
