import * as React from 'react';
import * as styles from './query_summary_view.module.css';

import { useQueryState } from '../../connection/query_executor.js';

interface QueryExecutionSummaryProps {
    conn: number;
    query: number;
}

export function QueryExecutionSummaryView(props: QueryExecutionSummaryProps) {
    const query = useQueryState(props.conn, props.query);
    if (!query) {
        return <div />;
    }

    return (
        <div className={styles.root}>
            <div>Status: {query.status}</div>
            <div>Title: {query.queryMetadata.title}</div>
            <div>Last update: {query.metrics.lastUpdatedAt?.toString()}</div>
            <div>Bytes received: {query.metrics.stream.totalDataBytesReceived}</div>
            <div>Rows received: {query.metrics.stream.totalRowsReceived}</div>
        </div>
    );
}
