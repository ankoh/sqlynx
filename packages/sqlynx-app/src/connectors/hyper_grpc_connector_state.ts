import { VariantKind } from '../utils/variant.js';
import { HyperGrpcConnectionParams } from './connection_params.js';
import { HyperDatabaseConnection } from '../platform/hyperdb_client.js';

export interface HyperGrpcTimings {
    /// The time when the setup started
    setupStartedAt: Date | null;
    /// The time when the setup got cancelled
    setupCancelledAt: Date | null;
    /// The time when the setup failed
    setupFailedAt: Date | null;
}

export interface HyperGrpcState {
    /// The timings
    timings: HyperGrpcTimings;
    /// The auth params
    setupParams: HyperGrpcConnectionParams | null;
    /// The authentication error
    connectionError: string | null;
    /// The Hyper connection
    connection: HyperDatabaseConnection | null;
}

export const CONNECTION_DEFAULT_STATE: HyperGrpcState = {
    timings: {
        setupCancelledAt: null,
        setupFailedAt: null,
        setupStartedAt: null,
    },
    setupParams: null,
    connectionError: null,
    connection: null,
};

export const RESET = Symbol('RESET');
export const SETUP_CANCELLED = Symbol('SETUP_CANCELLED');
export const SETUP_FAILED = Symbol('SETUP_FAILED');
export const SETUP_STARTED = Symbol('SETUP_STARTED');
export const CHANNEL_SETUP = Symbol('SETUP_STARTED');

export type HyperGrpcConnectorAction =
    | VariantKind<typeof RESET, null>
    | VariantKind<typeof SETUP_STARTED, HyperGrpcConnectionParams>
    | VariantKind<typeof SETUP_FAILED, string>
    | VariantKind<typeof SETUP_CANCELLED, string>;

export function reduceAuthState(state: HyperGrpcState, action: HyperGrpcConnectorAction): HyperGrpcState {
    switch (action.type) {
        case RESET:
            return {
                timings: {
                    setupStartedAt: new Date(),
                    setupCancelledAt: null,
                    setupFailedAt: null,
                },
                setupParams: state.setupParams,
                connectionError: null,
                connection: null,
            };
        case SETUP_STARTED:
            return {
                timings: {
                    setupStartedAt: new Date(),
                    setupCancelledAt: null,
                    setupFailedAt: null,
                },
                setupParams: action.value,
                connectionError: null,
                connection: null,
            };
        case SETUP_CANCELLED:
            return {
                ...state,
                timings: {
                    ...state.timings,
                    setupCancelledAt: new Date(),
                },
                connectionError: action.value,
                connection: null
            };
        case SETUP_FAILED:
            return {
                ...state,
                timings: {
                    ...state.timings,
                    setupFailedAt: new Date(),
                },
                connectionError: action.value,
                connection: null
            };
    }
}
