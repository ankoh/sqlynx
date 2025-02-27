import { VariantKind } from "../../utils/variant.js";

export const METRIC_REQUEST_COUNT = Symbol("METRIC_REQUEST_COUNT");
export const METRIC_LATEST_REQUEST_STARTED = Symbol("METRIC_LATEST_REQUEST_STARTED");

export type QueryStageMetricVariant =
    | VariantKind<typeof METRIC_REQUEST_COUNT, number>
    | VariantKind<typeof METRIC_LATEST_REQUEST_STARTED, Date>
    ;

interface QueryStageMetric {
    /// The name
    name: string;
    /// The description
    description: string;
    /// The icon name
    icon: string | null;
    /// The value
    value: QueryStageMetricVariant;
}

enum QueryStageType {
    PREPARE_QUERY,
    SEND_QUERY,
    AWAIT_FIRST_QUERY_RESULT,
    COLLECT_ALL_QUERY_RESULTS,
    // Finished, failed or cancelled
    QUERY_STOPPED,
}

interface QueryStage {
    /// The stage type
    stageType: QueryStageType;
    /// The metrics
    stageMetrics: QueryStageMetric[];
    /// Started at?
    startedAt: Date;
    /// Finished at?
    finishedAt: Date;
    /// Finished at?
    cancelledAt: Date;
    /// Failed at?
    failedAt: Date;
}

export interface QuerySummary {
    /// The stages
    stages: QueryStage[];
}
