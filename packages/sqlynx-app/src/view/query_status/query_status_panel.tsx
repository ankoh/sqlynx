import * as React from 'react';
import * as styles from './query_status_panel.module.css';

import { RectangleWaveSpinner } from '../foundations/spinners.js';
import { QueryExecutionState, QueryExecutionStatus } from '../../connection/query_execution_state.js';

interface Props {
    query: QueryExecutionState | null;
}

export const QueryStatusPanel: React.FC<Props> = (props: Props) => {
    const getStatusText = (status: QueryExecutionStatus | null) => {
        if (status == null) {
            return '';
        }
        switch (status) {
            case QueryExecutionStatus.REQUESTED:
                return 'Requested query';
            case QueryExecutionStatus.PREPARED:
                return 'Prepared query';
            case QueryExecutionStatus.QUEUED:
                return 'Queued query';
            case QueryExecutionStatus.RUNNING:
                return 'Executing query';
            case QueryExecutionStatus.RECEIVED_FIRST_BATCH:
                return 'Executing query, received first result';
            case QueryExecutionStatus.RECEIVED_ALL_BATCHES:
                return 'Executing query, received all results';
            case QueryExecutionStatus.PROCESSED_RESULTS:
                return 'Processed results';
            case QueryExecutionStatus.FAILED:
                return 'Query execution failed';
            case QueryExecutionStatus.CANCELLED:
                return 'Query was cancelled';
            case QueryExecutionStatus.SUCCEEDED:
                return 'Query executed successfully';
        }
    };
    if (props.query == null) {
        return <div className={styles.root}></div>;
    }
    switch (props.query.status) {
        case QueryExecutionStatus.PREPARED:
        case QueryExecutionStatus.QUEUED:
        case QueryExecutionStatus.RUNNING:
        case QueryExecutionStatus.RECEIVED_FIRST_BATCH:
        case QueryExecutionStatus.RECEIVED_ALL_BATCHES:
        case QueryExecutionStatus.PROCESSED_RESULTS: {
            return (
                <div className={styles.root}>
                    <RectangleWaveSpinner active={true} />
                    <div className={styles.status}>{getStatusText(props.query.status)}</div>
                </div>
            );
        }
        case QueryExecutionStatus.FAILED:
        case QueryExecutionStatus.CANCELLED: {
            return (
                <div className={styles.root}>
                    <div className={styles.status}>{getStatusText(props.query.status)}</div>
                    <div className={styles.error_message}>{props.query.error?.message}</div>
                </div>
            );
        }
        case QueryExecutionStatus.SUCCEEDED: {
            return (
                <div className={styles.root}>
                    <div className={styles.status}>{getStatusText(props.query.status)}</div>
                </div>
            );
        }
    }
};
