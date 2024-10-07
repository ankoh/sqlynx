import * as arrow from 'apache-arrow';
import * as sqlynx_compute from '@ankoh/sqlynx-compute';

import { ColumnStatsVariant, ColumnSummaryTask, TableSummaryTask, TaskStatus, TableOrderingTask } from './computation_task.js';

/// The computation state
interface ComputationState {
    /// The computation id
    computationId: number;

    /// The input data frame
    inputFrame: sqlynx_compute.DataFrame;
    /// The input table
    inputTable: arrow.Table;

    /// The ordering task status
    orderingTaskStatus: TaskStatus | null;
    /// The ordering task
    orderingTask: TableOrderingTask | null;
    /// The ordered table
    orderedTable: arrow.Table | null;

    /// The task status
    tableSummaryTaskStatus: TaskStatus | null;
    /// The table stats task
    tableSummaryTask: TableSummaryTask | null;
    /// The table stats
    tableSummary: arrow.Table | null;

    /// The pending column tasks
    columnSummariesPending: Map<number, ColumnSummaryTask>;
    /// The running column tasks
    columnSummariesRunning: Map<number, ColumnSummaryTask>;
    /// The column stats
    columnSummaries: (ColumnStatsVariant | TaskStatus | null)[];
}

/// The computation registry
///
/// Note that we're deliberately not using immutable maps for the connections here.
/// Following the same reasoning as with the session registry, we don't have code that
/// explicitly observes modifications of the registry map.
/// Instead, shallow-compare the entire registry object again.
export interface ComputationRegistry {
    /// The computations
    computationMap: Map<number, ComputationState>;
}
