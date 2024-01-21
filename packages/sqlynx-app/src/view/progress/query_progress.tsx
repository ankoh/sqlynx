import * as React from 'react';
import { RectangleWaveSpinner } from '../../view/spinners';
import { QueryExecutionProgress, QueryExecutionTaskStatus } from '../../connectors/query_execution';

import styles from './query_progress.module.css';

interface Props {
    queryStatus: QueryExecutionTaskStatus | null;
    queryProgress: QueryExecutionProgress | null;
}

export const QueryProgress: React.FC<Props> = (props: Props) => {
    const getStatusText = (status: QueryExecutionTaskStatus | null) => {
        if (status == null) {
            return '';
        }
        switch (status) {
            case QueryExecutionTaskStatus.ACCEPTED:
                return 'Sending query';
            case QueryExecutionTaskStatus.STARTED:
                return 'Executing query';
            case QueryExecutionTaskStatus.RECEIVED_SCHEMA:
                return 'Executing query, received schema';
            case QueryExecutionTaskStatus.RECEIVED_FIRST_RESULT:
                return 'Executing query, received first result';
            case QueryExecutionTaskStatus.FAILED:
                return 'Query execution failed';
            case QueryExecutionTaskStatus.CANCELLED:
                return 'Query was cancelled';
            case QueryExecutionTaskStatus.SUCCEEDED:
                return 'Query executed successfully';
        }
    };
    const queryIsOngoing = (status: QueryExecutionTaskStatus | null) => {
        if (status == null) {
            return false;
        }
        switch (status) {
            case QueryExecutionTaskStatus.ACCEPTED:
            case QueryExecutionTaskStatus.STARTED:
            case QueryExecutionTaskStatus.RECEIVED_SCHEMA:
            case QueryExecutionTaskStatus.RECEIVED_FIRST_RESULT:
                return true;
            case QueryExecutionTaskStatus.FAILED:
            case QueryExecutionTaskStatus.CANCELLED:
            case QueryExecutionTaskStatus.SUCCEEDED:
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
