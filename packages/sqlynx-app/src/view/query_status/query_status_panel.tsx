import * as React from 'react';
import { RectangleWaveSpinner } from '../foundations/spinners.js';
import { QueryExecutionState, QueryExecutionStatus } from '../../connection/query_execution_state.js';

import * as styles from './query_status_panel.module.css';

interface Props {
    query: QueryExecutionState | null;
}

export const QueryStatusPanel: React.FC<Props> = (props: Props) => {
    const getStatusText = (status: QueryExecutionStatus | null) => {
        if (status == null) {
            return '';
        }
        switch (status) {
            case QueryExecutionStatus.ACCEPTED:
                return 'Sending query';
            case QueryExecutionStatus.STARTED:
                return 'Executing query';
            case QueryExecutionStatus.RECEIVED_SCHEMA:
                return 'Executing query, received schema';
            case QueryExecutionStatus.RECEIVED_FIRST_RESULT:
                return 'Executing query, received first result';
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
        case QueryExecutionStatus.ACCEPTED:
        case QueryExecutionStatus.STARTED:
        case QueryExecutionStatus.RECEIVED_SCHEMA:
        case QueryExecutionStatus.RECEIVED_FIRST_RESULT: {
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
