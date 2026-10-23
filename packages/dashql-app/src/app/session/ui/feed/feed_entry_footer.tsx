import * as React from 'react';
import * as styles from './feed_entry_footer.module.css';

import icons from '@ankoh/dashql-svg-symbols';

import { QueryExecutionState } from '../../../../query/query_execution_state.js';
import { QueryResultView } from '../../compute/ui/query_result/query_result_view.js';
import { TableColumnHeader } from '../../compute/ui/query_result/data_table_cell.js';
import { VerticalTabs, VerticalTabVariant, type VerticalTabProps } from '../../../../ui/foundations/vertical_tabs.js';
import { VisualizationDispatch } from '../../compute/ui/visualization/visualization_dispatch.js';
import { ResolvedVisualizeQuery } from '../../scripts/script_types.js';
import { TraceLogPanel } from '../trace_log_panel.js';
import { TabHeader, useResultRowCount, formatRowCountDetail } from '../tab_header.js';
import { QueryResultToolbar, useQueryResultRowCounts } from '../../compute/ui/query_result/query_result_toolbar.js';
import { QueryResultDownloadButton } from '../../compute/ui/query_result/query_result_download_button.js';

const FEED_LIMIT_RESULT_ROWS = 6;
/// The Log tab's viewport auto-expands to fit its rows and caps at this many (then scrolls).
const FEED_LIMIT_LOG_ROWS = 6;
/// Cap the Vega-Lite chart height in the feed footer so a single vis entry doesn't dominate the
/// feed while scrolling. Only the vega-lite renderer honors this; the umap scatter fills its
/// container as before.
const FEED_VISUALIZATION_HEIGHT = 180;

const enum FooterTab {
    ExecutionLog = 0,
    Table = 1,
    Visualization = 2,
}

export interface FeedEntryFooterDependencies {
    useResultRowCount: typeof useResultRowCount;
    useQueryResultRowCounts: typeof useQueryResultRowCounts;
    QueryResultToolbar: typeof QueryResultToolbar;
    QueryResultDownloadButton: typeof QueryResultDownloadButton;
    QueryResultView: typeof QueryResultView;
}

const DEFAULT_DEPENDENCIES: FeedEntryFooterDependencies = {
    useResultRowCount,
    useQueryResultRowCounts,
    QueryResultToolbar,
    QueryResultDownloadButton,
    QueryResultView,
};

interface FeedEntryFooterProps {
    sessionId: string;
    /// The latest query execution for this script.
    queryState: QueryExecutionState | null;
    visualizeQuery: ResolvedVisualizeQuery | null;
    onShowStatus?: () => void;
    onShowTable?: () => void;
    onShowVisualization?: () => void;
    dependencies?: FeedEntryFooterDependencies;
}

export const FeedEntryFooter: React.FC<FeedEntryFooterProps> = (props) => {
    const dependencies = props.dependencies ?? DEFAULT_DEPENDENCIES;
    const { hasResult, totalRows } = dependencies.useResultRowCount(props.queryState);
    const searchRows = dependencies.useQueryResultRowCounts(props.queryState);
    const hasVisualization = hasResult && props.visualizeQuery != null && props.visualizeQuery.renderer !== 'table';

    const queryTraceId = props.queryState?.traceId ?? null;

    const [selectedTab, setSelectedTab] = React.useState<FooterTab>(
        () => hasVisualization ? FooterTab.Visualization
            : hasResult ? FooterTab.Table
                : FooterTab.ExecutionLog
    );

    const prevHasResult = React.useRef(hasResult);
    React.useEffect(() => {
        if (hasResult && !prevHasResult.current) {
            setSelectedTab(hasVisualization ? FooterTab.Visualization : FooterTab.Table);
        } else if (!hasResult && prevHasResult.current) {
            setSelectedTab(FooterTab.ExecutionLog);
        }
        prevHasResult.current = hasResult;
    }, [hasResult, hasVisualization, queryTraceId]);

    const tabProps = React.useMemo<Record<FooterTab, VerticalTabProps>>(() => ({
        [FooterTab.ExecutionLog]: {
            tabId: FooterTab.ExecutionLog,
            icon: `${icons}#log_24`,
            labelShort: 'Log',
            ariaLabel: 'Execution log',
            description: 'Execution log',
            disabled: queryTraceId == null,
        },
        [FooterTab.Table]: {
            tabId: FooterTab.Table,
            icon: `${icons}#table_24`,
            labelShort: 'Data',
            ariaLabel: 'Query results',
            description: 'Query results',
            disabled: !hasResult,
        },
        [FooterTab.Visualization]: {
            tabId: FooterTab.Visualization,
            icon: `${icons}#graph_24`,
            labelShort: 'Chart',
            ariaLabel: 'Visualization',
            description: 'Visualization',
            disabled: !hasVisualization,
        },
    }), [queryTraceId, hasResult, hasVisualization]);

    // Only surface tabs that are actually usable in the sidebar. Rendering the disabled tabs
    // (e.g. Data/Chart before a result exists) padded the vertical tab bar out to its full height,
    // which looked odd next to a footer body that only holds a one-row table or a short log.
    const tabKeys = React.useMemo(() => {
        const keys: FooterTab[] = [FooterTab.ExecutionLog];
        if (hasResult) keys.push(FooterTab.Table);
        if (hasVisualization) keys.push(FooterTab.Visualization);
        return keys;
    }, [hasResult, hasVisualization]);
    const enabledTabKeys = React.useMemo(
        () => tabKeys.filter(tab => !tabProps[tab].disabled),
        [tabKeys, tabProps],
    );
    React.useEffect(() => {
        if (enabledTabKeys.length > 0 && !enabledTabKeys.includes(selectedTab)) {
            setSelectedTab(enabledTabKeys[0]);
        }
    }, [enabledTabKeys, selectedTab]);

    const displayedRows = searchRows.matchingRows ?? totalRows;
    const dataRowCount = displayedRows != null ? Math.min(displayedRows, FEED_LIMIT_RESULT_ROWS) : null;
    const rowCountDetail = totalRows != null
        ? (searchRows.matchingRows != null
            ? (searchRows.matchingRows > FEED_LIMIT_RESULT_ROWS
                ? `${dataRowCount} of ${searchRows.matchingRows} matching rows`
                : `${searchRows.matchingRows} of ${searchRows.currentRows ?? totalRows} rows`)
            : totalRows > FEED_LIMIT_RESULT_ROWS
                ? `${dataRowCount} of ${totalRows} rows`
                : `${totalRows} ${totalRows === 1 ? 'row' : 'rows'}`)
        : null;

    // The visualization renders the full cloud (no feed row cap), so the header just shows the
    // total row count.
    const pointCountDetail = formatRowCountDetail(totalRows);

    const tabRenderers = React.useMemo(() => ({
        [FooterTab.ExecutionLog]: () => (
            <TraceLogPanel
                traceId={queryTraceId}
                title="Execution Logs"
                maxRows={FEED_LIMIT_LOG_ROWS}
                onHeaderClick={props.onShowStatus}
            />
        ),
        [FooterTab.Table]: () => (
            <>
                <TabHeader
                    title="Query Results"
                    detail={rowCountDetail}
                    onClick={props.onShowTable}
                    actions={props.queryState == null ? undefined : (
                        <>
                            <dependencies.QueryResultToolbar query={props.queryState} />
                            <dependencies.QueryResultDownloadButton query={props.queryState} />
                        </>
                    )}
                />
                {props.queryState != null && (
                    <dependencies.QueryResultView
                        query={props.queryState}
                        debugMode={false}
                        maxRows={FEED_LIMIT_RESULT_ROWS}
                        columnHeader={TableColumnHeader.OnlyColumnName}
                        cellBackground="var(--session_feed_entry_footer_background)"
                        onShowTable={props.onShowTable}
                        compact
                    />
                )}
            </>
        ),
        [FooterTab.Visualization]: () => (
            <div className={styles.visualization_tab}>
                <TabHeader
                    title="Visualization"
                    detail={pointCountDetail}
                    onClick={props.onShowVisualization}
                />
                {props.queryState != null && (
                    <div className={styles.visualization_body}>
                        <VisualizationDispatch
                            query={props.queryState}
                            visualizeQuery={props.visualizeQuery}
                            height={FEED_VISUALIZATION_HEIGHT}
                            transparent
                            wheelZoom={false}
                        />
                    </div>
                )}
            </div>
        ),
    }), [queryTraceId, props.queryState, props.visualizeQuery, rowCountDetail, pointCountDetail, props.onShowStatus, props.onShowTable, props.onShowVisualization]);

    return (
        <VerticalTabs
            className={styles.footer_container}
            variant={VerticalTabVariant.Stacked}
            tabKeys={tabKeys}
            tabProps={tabProps}
            tabRenderers={tabRenderers}
            selectedTab={selectedTab}
            selectTab={setSelectedTab}
        />
    );
};
