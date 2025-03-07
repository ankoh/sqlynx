import * as React from 'react';
import * as styles from './query_info_view.module.css';

import { useQueryState } from '../../connection/query_executor.js';
import { computeQueryInfoViewModel, QueryStage } from './query_info_view_model.js';
import { QueryExecutionState } from '../../connection/query_execution_state.js';
import { classNames } from '../../utils/classnames.js';

interface QueryStageViewProps {
    query: QueryExecutionState;
    stage: QueryStage;
}

function QueryStageView(props: QueryStageViewProps) {
    let barStyle: string | undefined = undefined;
    if (props.stage.startedAt == null) {
        barStyle = styles.stage_bar_default;
    } else if (props.query.metrics.querySucceededAt != null) {
        barStyle = styles.stage_bar_succeeded;
    } else if (props.query.metrics.queryFailedAt != null) {
        barStyle = styles.stage_bar_failed;
    } else if (props.query.metrics.queryCancelledAt != null) {
        barStyle = styles.stage_bar_cancelled;
    } else if (props.stage.ongoing) {
        barStyle = styles.stage_bar_started_ongoing;
    } else {
        barStyle = styles.stage_bar_succeeded;
    }
    return (
        <div className={classNames(styles.stage_bar, barStyle)} />
    );
}

interface QueryInfoViewProps {
    /// The connection id
    conn: number;
    /// The query id
    query: number;
}

export function QueryInfoView(props: QueryInfoViewProps) {
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
                <div className={styles.stage_bars}>
                    {queryInfo.stages.map((s, i) => <QueryStageView key={i} stage={s} query={query!} />)}
                </div>
            </div>
        </div>
    );
}
