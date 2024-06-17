import * as React from 'react';
import * as styles from './query_result_view.module.css';

import { QueryExecutionState } from '../../connectors/query_execution_state.js';
import { DataTable } from './data_table.js';
import { formatMilliseconds } from '../../utils/index.js';

interface MetricEntryProps {
    name: string;
    value: string;
    delimiter?: boolean;
}

function MetricEntry(props: MetricEntryProps) {
    return (
        <>
            <div className={styles.metric_key}>
                {props.name}
            </div>
            <div className={styles.metric_value}>
                {props.value}
            </div>
        </>
    );
}

interface Props {
    query: QueryExecutionState | null;
}

export function QueryResultView(props: Props) {
    if (props.query == null) {
        return <div />
    }

    const metrics = props.query.metrics;
    const untilSchema = (metrics.durationUntilSchemaMs == null) ? "-" : formatMilliseconds(metrics.durationUntilSchemaMs);
    const untilFirstRow = (metrics.durationUntilFirstBatchMs == null) ? "-" : formatMilliseconds(metrics.durationUntilFirstBatchMs);
    const queryDuration = (metrics.queryDurationMs == null) ? "-" : formatMilliseconds(metrics.queryDurationMs);
    return (
        <div className={styles.root}>
            <DataTable className={styles.data_table} data={props.query.resultTable} />
            <div className={styles.info_container}>
                <div className={styles.metrics_container}>
                    <div className={styles.metrics_group}>
                        <MetricEntry name="Records" value={metrics.rowsReceived.toString()} />
                        <MetricEntry name="Record Batches" value={metrics.batchesReceived.toString()} />
                        <MetricEntry name="Data Bytes" value="" delimiter />
                    </div>
                    <div className={styles.metrics_group}>
                        <MetricEntry name="Schema At" value={untilSchema} />
                        <MetricEntry name="First Batch At" value={untilFirstRow} />
                        <MetricEntry name="Finished At" value={queryDuration} />
                    </div>
                    <div className={styles.metrics_group}>
                        <MetricEntry name="Trace Id" value="foo" />
                        <MetricEntry name="Span Id" value="foo" />
                        <MetricEntry name="Parentspan Id" value="foo" />
                    </div>
                </div>
            </div>
        </div>
    );
}