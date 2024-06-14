import * as React from 'react';
import { RectangleWaveSpinner } from '../foundations/spinners.js';
import { QueryExecutionProgress, QueryExecutionStatus } from '../../connectors/query_execution_state.js';

import * as styles from './query_progress.module.css';

interface Props {
    queryStatus: QueryExecutionStatus | null;
    queryProgress: QueryExecutionProgress | null;
}

export const QueryProgress: React.FC<Props> = (props: Props) => {
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
    const queryIsOngoing = (status: QueryExecutionStatus | null) => {
        if (status == null) {
            return false;
        }
        switch (status) {
            case QueryExecutionStatus.ACCEPTED:
            case QueryExecutionStatus.STARTED:
            case QueryExecutionStatus.RECEIVED_SCHEMA:
            case QueryExecutionStatus.RECEIVED_FIRST_RESULT:
                return true;
            case QueryExecutionStatus.FAILED:
            case QueryExecutionStatus.CANCELLED:
            case QueryExecutionStatus.SUCCEEDED:
                return false;
        }
    };
    return (
        <div className={styles.root}>
            {queryIsOngoing(props.queryStatus) && <RectangleWaveSpinner active={true} />}
            <div className={styles.status}>{getStatusText(props.queryStatus)}</div>
        </div>
    );
};
