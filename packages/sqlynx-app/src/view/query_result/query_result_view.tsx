import * as React from 'react';
import * as styles from './query_result_view.module.css';

import { QueryExecutionState } from '../../connectors/query_execution_state.js';
import { DataTable } from './data_table.js';
import { useComputationRegistry } from '../../compute/computation_registry.js';
import { QueryResultInfo } from './query_result_info.js';

interface Props {
    query: QueryExecutionState | null;
}

export function QueryResultView(props: Props) {
    const [computationState, computationDispatch] = useComputationRegistry();
    const [infoExpanded, setInfoExpanded] = React.useState(false);

    // Query is null?
    if (props.query == null) {
        return <div />;
    }
    // Resolve the table computation
    const tableComputation = computationState.tableComputations.get(props.query.queryId) ?? null;
    if (tableComputation == null) {
        return <div />;
    }
    // Toggle data info
    const toggleInfo = () => setInfoExpanded(e => !e);
    return (
        <div className={styles.root}>
            <DataTable
                className={styles.data_table}
                table={tableComputation}
                dispatchComputation={computationDispatch}
            />
            <div className={styles.info_toggle} onClick={toggleInfo} />
            {infoExpanded && <QueryResultInfo query={props.query} />}
        </div>
    );
}
