import * as React from 'react';
import * as symbols from '../../../static/svg/symbols.generated.svg';
import * as styles from './query_info_view.module.css';

import { useQueryState } from '../../connection/query_executor.js';
import { computeQueryInfoViewModel, QueryStage, QueryMetricValue, METRIC_REQUEST_COUNT, METRIC_LATEST_REQUEST_STARTED } from './query_info_view_model.js';
import { QueryExecutionState, queryIsDone } from '../../connection/query_execution_state.js';
import { classNames } from '../../utils/classnames.js';
import { ButtonSize, ButtonVariant, IconButton } from '../../view/foundations/button.js';

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

interface QueryStageMetricViewProps {
    metric: QueryMetricValue;
}

function QueryMetricView(props: QueryStageMetricViewProps) {
    switch (props.metric.type) {
        case METRIC_REQUEST_COUNT:
            return <div />;
        case METRIC_LATEST_REQUEST_STARTED:
            return <div />;
        default:
            return <div />;
    }
}

interface QueryInfoViewProps {
    /// The classname
    className?: string;
    /// The styles
    style?: React.CSSProperties;
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
    /// Is the query done?
    const isDone = query && queryIsDone(query.status);

    // Determine the current query metrics
    let metrics: QueryMetricValue[] = [];
    for (const stage of queryInfo!.stages) {
        if (stage.ongoing) {
            metrics = stage.stageMetrics;
            break;
        }
    }
    if (metrics.length == 0) {
        metrics = queryInfo!.queryMetrics;
    }

    if (!query || !queryInfo) {
        return <div />;
    }
    return (
        <div className={classNames(props.className, styles.root)} style={props.style}>
            <div className={styles.title}>
                {query.queryMetadata.title}
            </div>
            <div className={styles.metrics}>
                {metrics.map((m, i) => <QueryMetricView key={i} metric={m} />)}
            </div>
            <div className={styles.stage_bars}>
                {queryInfo.stages.map((s, i) => <QueryStageView key={i} stage={s} query={query} />)}
            </div>
            <div className={styles.action_container}>
                {isDone
                    ? (
                        <IconButton
                            variant={ButtonVariant.Invisible}
                            size={ButtonSize.Small}
                            aria-label="Info"
                        >
                            <svg width="16px" height="16px">
                                <use xlinkHref={`${symbols}#info_circle`} />
                            </svg>
                        </IconButton>
                    )
                    : (
                        <IconButton
                            variant={ButtonVariant.Invisible}
                            size={ButtonSize.Small}
                            aria-label="Cancel"
                        >
                            <svg width="16px" height="16px">
                                <use xlinkHref={`${symbols}#x`} />
                            </svg>
                        </IconButton>
                    )
                }
            </div>
        </div>
    );
}
