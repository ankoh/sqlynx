import * as React from 'react';
import * as styles from './query_info_view.module.css';

import { useQueryState } from '../../connection/query_executor.js';
import { computeQueryInfoViewModel } from './query_info_view_model.js';

interface QueryExecutionSummaryProps {
    conn: number;
    query: number;
}

export function QueryInfoView(props: QueryExecutionSummaryProps) {
    // Resolve the query state
    const query = useQueryState(props.conn, props.query);
    // Compute the query info view model
    const queryInfo = React.useMemo(() => (query != null) ? computeQueryInfoViewModel(query) : null, [query]);

    if (!queryInfo) {
        return <div />;
    }

    return (
        <div className={styles.root}>
            <div className={styles.stages_container}>
                {queryInfo.stages.map(s => (s.startedAt != null) ? "+" : "-")}
            </div>
        </div>
    );
}
