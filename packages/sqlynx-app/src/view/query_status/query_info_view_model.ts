import { VariantKind } from "../../utils/variant.js";
import { QueryExecutionState, QueryExecutionStatus } from "../../connection/query_execution_state.js";

export const METRIC_REQUEST_COUNT = Symbol("METRIC_REQUEST_COUNT");
export const METRIC_LATEST_REQUEST_STARTED = Symbol("METRIC_LATEST_REQUEST_STARTED");

export type QueryStageMetricVariant =
    | VariantKind<typeof METRIC_REQUEST_COUNT, number>
    | VariantKind<typeof METRIC_LATEST_REQUEST_STARTED, Date>
    ;

export enum QueryStageType {
    PREPARE_QUERY,
    SEND_QUERY,
    QUEUE_QUERY,
    AWAIT_FIRST_QUERY_RESULT,
    // Finished, failed or cancelled
    AWAIT_QUERY_END,
    PROCESS_QUERY_RESULTS,
}

export interface QueryStage {
    /// The stage type
    stageType: QueryStageType;
    /// The metrics
    stageMetrics: QueryStageMetricVariant[];
    /// Started at?
    startedAt: Date | null;
    /// Finished?
    ongoing: boolean;
}

/// The view model for a query
export interface QueryInfoViewModel {
    /// The stages
    stages: QueryStage[];
    /// Finished at?
    error: Error | null;
}

/// Helper to compute the view model for a connection entry
export function computeQueryInfoViewModel(query: QueryExecutionState): QueryInfoViewModel {
    let stages: QueryStage[] = [];
    if (query.metrics.queryPreparingStartedAt != null) {
        stages.push({
            stageType: QueryStageType.PREPARE_QUERY,
            stageMetrics: [],
            startedAt: query.metrics.queryPreparingStartedAt,
            ongoing: query.status == QueryExecutionStatus.PREPARING,
        });
    }
    stages.push({
        stageType: QueryStageType.SEND_QUERY,
        stageMetrics: [],
        startedAt: query.metrics.querySendingStartedAt,
        ongoing: query.status == QueryExecutionStatus.SENDING,
    });
    if (query.metrics.queryPreparingStartedAt != null) {
        stages.push({
            stageType: QueryStageType.QUEUE_QUERY,
            stageMetrics: [],
            startedAt: query.metrics.queryQueuedStartedAt,
            ongoing: query.status == QueryExecutionStatus.QUEUED,
        });
    };
    stages.push({
        stageType: QueryStageType.AWAIT_FIRST_QUERY_RESULT,
        stageMetrics: [],
        startedAt: query.metrics.queryRunningStartedAt,
        ongoing: query.status == QueryExecutionStatus.RUNNING,
    });
    stages.push({
        stageType: QueryStageType.AWAIT_QUERY_END,
        stageMetrics: [],
        startedAt: query.metrics.receivedFirstBatchAt,
        ongoing: query.status == QueryExecutionStatus.RECEIVED_FIRST_BATCH,
    });
    stages.push({
        stageType: QueryStageType.PROCESS_QUERY_RESULTS,
        stageMetrics: [],
        startedAt: query.metrics.receivedAllBatchesAt,
        ongoing: query.status == QueryExecutionStatus.PROCESSING_RESULTS,
    });
    return {
        stages: stages,
        error: query.error,
    };
}
