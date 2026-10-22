import { AttachedDatabaseDispatch } from './attached_database_registry.js';
import { HEALTH_CHECK_CANCELLED, HEALTH_CHECK_FAILED, HEALTH_CHECK_STARTED, HEALTH_CHECK_SUCCEEDED } from './attached_database_state.js';
import { DetailedError } from './connection_types.js';
import { HyperDatabaseChannel } from './hyper/hyperdb_grpc_client.js';
import { QueryExecutor } from './query_executor.js';
import { QueryType } from './query_execution_state.js';
import { SalesforceDatabaseChannel } from './salesforce/salesforce_api_client.js';
import { TrinoChannelInterface } from './trino/trino_channel.js';

export type HealthCheckChannel =
    | { type: 'hyper'; channel: HyperDatabaseChannel }
    | { type: 'salesforce'; channel: SalesforceDatabaseChannel }
    | { type: 'trino'; channel: TrinoChannelInterface };

function pickProbeQuery(channel: HealthCheckChannel): string {
    switch (channel.type) {
        case 'trino':
            return 'select 1';
        case 'hyper':
        case 'salesforce':
            return 'select 1 as healthy';
    }
}

function toDetailedError(error: unknown): DetailedError {
    if (error instanceof Error) {
        return { message: error.message };
    }
    if (error != null && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
        return { message: (error as { message: string }).message };
    }
    return { message: String(error ?? 'health check failed') };
}

/// Run the connection's health check through the query executor so the probe shows up
/// in the internals query viewer like any other query. The caller passes the channel
/// it already holds locally after setup — we don't wait for the React state update
/// that publishes the channel into the connection map.
///
/// Dispatches HEALTH_CHECK_STARTED before the first await, then maps the outcome to
/// HEALTH_CHECK_SUCCEEDED / FAILED / CANCELLED and rethrows on non-success so callers
/// keep their existing try/catch semantics.
export async function performHealthCheck(
    executor: QueryExecutor,
    connectionId: string,
    channel: HealthCheckChannel,
    dispatch: AttachedDatabaseDispatch,
    abortSignal: AbortSignal,
): Promise<void> {
    dispatch({ type: HEALTH_CHECK_STARTED, value: null });
    abortSignal.throwIfAborted();

    const [, execution] = executor(connectionId, {
        query: pickProbeQuery(channel),
        analyzeResults: false,
        metadata: {
            queryType: QueryType.HEALTH_CHECK,
            title: 'Health Check',
            description: null,
            issuer: 'Connection Setup',
            userProvided: false,
        },
        channelOverride: channel,
    });
    const table = await execution;

    if (abortSignal.aborted) {
        dispatch({ type: HEALTH_CHECK_CANCELLED, value: null });
        const abortError: Error & { name: string } = new Error('health check cancelled');
        abortError.name = 'AbortError';
        throw abortError;
    }
    if (table == null) {
        const detailed: DetailedError = { message: 'health check failed' };
        dispatch({ type: HEALTH_CHECK_FAILED, value: detailed });
        throw new Error(detailed.message);
    }
    dispatch({ type: HEALTH_CHECK_SUCCEEDED, value: null });
}
