import * as React from 'react';
import * as styles from './query_result_info.module.css';

import { QueryExecutionState } from '../../connection/query_execution_state.js';
import { ByteFormat, formatMilliseconds, formatThousands } from '../../utils/index.js';
import { formatBytes } from '../../utils/format.js';
import { CopyToClipboardButton } from '../../utils/clipboard.js';
import { ButtonSize, ButtonVariant } from '../foundations/button.js';

const LOG_CTX = "query_result_viewer"

interface MetricEntryProps {
    name: string;
    value: string;
    clipboard?: boolean;
}

function MetricEntry(props: MetricEntryProps) {
    return (
        <>
            <div className={styles.metric_key}>
                {props.name}
            </div>
            {
                props.clipboard
                    ? <div className={styles.metric_clipboard}>
                        <CopyToClipboardButton
                            variant={ButtonVariant.Default}
                            size={ButtonSize.Small}
                            value={props.value}
                            logContext={LOG_CTX}
                            aria-label={`Copy ${props.name}`}
                            aria-labelledby="" />
                    </div>
                    : <div className={styles.metric_value}>
                        {props.value}
                    </div>
            }
        </>
    );
}

interface ResultInfoProps {
    query: QueryExecutionState;
}

export function QueryResultInfo(props: ResultInfoProps) {
    const metrics = props.query.metrics;
    const rowsReceived = (metrics.rowsReceived == null) ? '-' : formatThousands(metrics.rowsReceived);
    const batchesReceived = (metrics.batchesReceived == null) ? '-' : formatThousands(metrics.batchesReceived);
    const dataBytes = (metrics.dataBytesReceived == null) ? '-' : formatBytes(metrics.dataBytesReceived, ByteFormat.SI);
    const untilFirstRow = (metrics.durationUntilFirstBatchMs == null) ? "-" : formatMilliseconds(metrics.durationUntilFirstBatchMs);
    const queryDuration = (metrics.queryDurationMs == null) ? "-" : formatMilliseconds(metrics.queryDurationMs);

    const b3TraceId = props.query.resultMetadata?.get("x-b3-traceid") ?? null;
    const b3SpanId = props.query.resultMetadata?.get("x-b3-spanid") ?? null;
    const b3ParentSpanId = props.query.resultMetadata?.get("x-b3-parentspanid") ?? null;
    const anyB3 = b3TraceId != null || b3SpanId != null || b3ParentSpanId != null;

    return (
        <div className={styles.info_container}>
            <div className={styles.metrics_container}>
                <div className={styles.metrics_group}>
                    <MetricEntry name="Records" value={rowsReceived} />
                    <MetricEntry name="Record Batches" value={batchesReceived} />
                    <MetricEntry name="Data Bytes" value={dataBytes.toString()} />
                </div>
                <div className={styles.metrics_group}>
                    <MetricEntry name="First Batch At" value={untilFirstRow} />
                    <MetricEntry name="Finished At" value={queryDuration} />
                </div>
                {anyB3 && (
                    <div className={styles.metrics_group}>
                        {b3TraceId && <MetricEntry name="TraceId" value={b3TraceId} clipboard />}
                        {b3SpanId && <MetricEntry name="SpanId" value={b3SpanId} clipboard />}
                        {b3ParentSpanId && <MetricEntry name="ParentSpanId" value={b3ParentSpanId} clipboard />}
                    </div>
                )}
            </div>
        </div>
    );
}
