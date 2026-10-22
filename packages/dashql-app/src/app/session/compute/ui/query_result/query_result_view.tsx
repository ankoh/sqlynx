import * as React from 'react';
import * as styles from './query_result_view.module.css';

import { QueryExecutionState } from '../../../connections/query_execution_state.js';
import { DataTable } from './data_table.js';
import { TableColumnHeader } from './data_table_cell.js';
import { useComputationRegistry } from '../../../../../compute/computation_registry.js';
import { classNames } from '../../../../../utils/classnames.js';

interface Props {
    query: QueryExecutionState | null;
    debugMode: boolean;
    maxRows?: number;
    columnHeader?: TableColumnHeader;
    cellBackground?: string;
    onShowTable?: () => void;
    fitHeight?: boolean;
    maxHeight?: number;
    compact?: boolean;
}

export function QueryResultView(props: Props) {
    const [computationState, computationDispatch] = useComputationRegistry();

    // Query is null?
    if (props.query == null) {
        return <div />;
    }
    // Resolve the table computation
    const tableComputation = computationState.tableComputations[props.query.queryId] ?? null;
    if (tableComputation == null) {
        return <div />;
    }
    // Toggle data info
    return (
        <div className={classNames(styles.root, { [styles.root_fit_height]: props.fitHeight })}>
            <DataTable
                className={styles.data_table}
                table={tableComputation}
                dispatchComputation={computationDispatch}
                debugMode={props.debugMode}
                maxRows={props.maxRows}
                columnHeader={props.columnHeader}
                cellBackground={props.cellBackground}
                onShowTable={props.onShowTable}
                fitHeight={props.fitHeight}
                maxHeight={props.maxHeight}
                compact={props.compact}
            />
        </div>
    );
}
