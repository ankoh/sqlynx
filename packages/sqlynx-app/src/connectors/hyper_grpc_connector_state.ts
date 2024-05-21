import { VariantKind } from '../utils/variant.js';
import { HyperGrpcConnectionParams } from './connection_params.js';

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
    connError: string | null;
}

export const CONNECTION_DEFAULT_STATE: HyperGrpcState = {
    timings: {
        setupCancelledAt: null,
        setupFailedAt: null,
        setupStartedAt: null,
    },
    setupParams: null,
    connError: null,
};

export const RESET = Symbol('RESET');
export const SETUP_CANCELLED = Symbol('AUTH_CANCELLED');
export const SETUP_FAILED = Symbol('AUTH_FAILED');
export const SETUP_STARTED = Symbol('AUTH_STARTED');

export type HyperGrpcConnectorAction =
    | VariantKind<typeof RESET, null>
    | VariantKind<typeof SETUP_STARTED, HyperGrpcConnectionParams>
    | VariantKind<typeof SETUP_FAILED, string>
    | VariantKind<typeof SETUP_CANCELLED, string>;

export function reduceAuthState(state: HyperGrpcState, action: HyperGrpcConnectorAction): HyperGrpcState {
    switch (action.type) {
        case SETUP_STARTED:
            return {
                timings: {
                    setupStartedAt: new Date(),
                    setupCancelledAt: null,
                    setupFailedAt: null,
                },
                setupParams: action.value,
                connError: null,
            };
        case RESET:
            return {
                timings: {
                    setupStartedAt: new Date(),
                    setupCancelledAt: null,
                    setupFailedAt: null,
                },
                setupParams: state.setupParams,
                connError: null,
            };
        case SETUP_STARTED:
            return {
                ...state,
            };
        case SETUP_CANCELLED:
            return {
                ...state,
                timings: {
                    ...state.timings,
                    setupCancelledAt: new Date(),
                },
                connError: action.value
            };
        case SETUP_FAILED:
            return {
                ...state,
                timings: {
                    ...state.timings,
                    setupFailedAt: new Date(),
                },
                connError: action.value,
            };
    }
}
