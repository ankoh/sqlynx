import * as React from 'react';

import icons from '@ankoh/dashql-svg-symbols';

import type { QueryExecutionState } from '../connections/query_execution_state.js';
import { QueryExecutionStatus } from '../connections/query_execution_state.js';
import type { ResolvedVisualizeQuery } from '../scripts/script_types.js';
import { KeyEventHandler, useKeyEvents } from '../../../utils/key_events.js';
import { QueryResultDetails } from '../compute/ui/query_result/query_result_details.js';
import { VisualizationDispatch } from '../compute/ui/visualization/visualization_dispatch.js';
import { ColumnAggregationBar } from '../compute/ui/visualization/column_aggregation_bar.js';
import { VerticalTabs, VerticalTabProps, VerticalTabVariant } from '../../../ui/foundations/vertical_tabs.js';
import { IndicatorStatus } from '../../../ui/foundations/status_indicator.js';
import { EntryStatusBar } from './entry_status_bar.js';
import { deriveEntryStatus, EntryStatusKind } from './entry_status_model.js';
import { TabHeader, formatRowCountDetail, useResultRowCount } from './tab_header.js';
import { TraceLogPanel } from './trace_log_panel.js';
import * as styles from './script_output_details.module.css';
import { classNames } from '../../../utils/classnames.js';

export enum ScriptDetailsTab {
    Editor = 0,
    QueryStatusPanel = 1,
    QueryResultView = 2,
    Visualization = 3,
}

interface Props {
    className?: string;
    embedded?: boolean;
    query: QueryExecutionState | null;
    visualizeQuery: ResolvedVisualizeQuery | null;
    initialTab?: ScriptDetailsTab;
    tableDebugMode: boolean;
    statusActions?: React.ReactNode;
    onCancelQuery?: () => void;
    expanded?: boolean;
    onToggleExpanded?: () => void;
    contentId?: string;
}

export const ScriptOutputDetails: React.FC<Props> = (props) => {
    const queryTraceId = props.query?.traceId ?? null;
    const { hasResult, totalRows } = useResultRowCount(props.query);
    const hasVisualization = hasResult && props.visualizeQuery != null && props.visualizeQuery.renderer !== 'table';
    const entryStatus = deriveEntryStatus(props.query);

    const defaultTab = () => {
        if (props.initialTab != null && props.initialTab !== ScriptDetailsTab.Editor) return props.initialTab;
        if (hasVisualization) return ScriptDetailsTab.Visualization;
        if (hasResult) return ScriptDetailsTab.QueryResultView;
        if (queryTraceId != null) return ScriptDetailsTab.QueryStatusPanel;
        return ScriptDetailsTab.QueryStatusPanel;
    };
    const [selectedTab, selectTab] = React.useState<ScriptDetailsTab>(defaultTab);

    const tabProps = React.useMemo<Record<ScriptDetailsTab, VerticalTabProps>>(() => ({
        [ScriptDetailsTab.Editor]: {
            tabId: ScriptDetailsTab.Editor,
            icon: '',
            labelShort: 'Editor',
            disabled: true,
        },
        [ScriptDetailsTab.QueryStatusPanel]: {
            tabId: ScriptDetailsTab.QueryStatusPanel,
            icon: `${icons}#log_24`,
            labelShort: 'Log',
            ariaLabel: 'Execution log',
            description: 'Execution log',
            disabled: queryTraceId == null,
        },
        [ScriptDetailsTab.QueryResultView]: {
            tabId: ScriptDetailsTab.QueryResultView,
            icon: `${icons}#table_24`,
            labelShort: 'Data',
            ariaLabel: 'Query results',
            description: 'Query results',
            disabled: !hasResult,
        },
        [ScriptDetailsTab.Visualization]: {
            tabId: ScriptDetailsTab.Visualization,
            icon: `${icons}#graph_24`,
            labelShort: 'Chart',
            ariaLabel: 'Visualization',
            description: 'Visualization',
            disabled: !hasVisualization,
        },
    }), [hasResult, hasVisualization, queryTraceId]);

    const tabKeys = React.useMemo(() => {
        const tabs = [ScriptDetailsTab.QueryStatusPanel];
        if (hasResult) tabs.push(ScriptDetailsTab.QueryResultView);
        if (hasVisualization) tabs.push(ScriptDetailsTab.Visualization);
        return tabs;
    }, [hasResult, hasVisualization]);
    const enabledTabs = React.useMemo(
        () => tabKeys.filter(tab => !tabProps[tab].disabled),
        [tabKeys, tabProps],
    );

    React.useEffect(() => {
        if (enabledTabs.length > 0 && !enabledTabs.includes(selectedTab)) {
            selectTab(enabledTabs[0]);
        }
    }, [enabledTabs, selectedTab]);

    const previousStatus = React.useRef<QueryExecutionStatus | null>(props.query?.status ?? null);
    React.useEffect(() => {
        const status = props.query?.status ?? null;
        if (status === previousStatus.current) return;
        previousStatus.current = status;
        if (status === QueryExecutionStatus.SUCCEEDED) {
            selectTab(props.visualizeQuery != null && props.visualizeQuery.renderer !== 'table'
                ? ScriptDetailsTab.Visualization
                : ScriptDetailsTab.QueryResultView);
        } else if (status != null) {
            selectTab(ScriptDetailsTab.QueryStatusPanel);
        }
    }, [props.query?.status, props.visualizeQuery]);

    const keyHandlers = React.useMemo<KeyEventHandler[]>(() => [{
        key: 'j',
        ctrlKey: true,
        callback: () => {
            if (enabledTabs.length === 0) return;
            selectTab(current => {
                const currentIndex = enabledTabs.indexOf(current);
                return enabledTabs[(currentIndex + 1) % enabledTabs.length];
            });
        },
    }], [enabledTabs]);
    useKeyEvents(keyHandlers);

    const cancel = entryStatus.kind === EntryStatusKind.Query ? props.onCancelQuery : undefined;
    const tabRenderers = React.useMemo(() => ({
        [ScriptDetailsTab.QueryStatusPanel]: () => (
            <div className={styles.tab_body}>
                <TraceLogPanel traceId={queryTraceId} title="Execution Logs" />
            </div>
        ),
        [ScriptDetailsTab.QueryResultView]: () => (
            <QueryResultDetails query={props.query!} debugMode={props.tableDebugMode} />
        ),
        [ScriptDetailsTab.Visualization]: () => (
            <div className={styles.visualization}>
                <TabHeader title="Visualization" detail={formatRowCountDetail(totalRows)} />
                <ColumnAggregationBar query={props.query} debugMode={props.tableDebugMode} />
                <div className={styles.visualization_body}>
                    <VisualizationDispatch query={props.query!} visualizeQuery={props.visualizeQuery} />
                </div>
            </div>
        ),
    }), [props.query, props.tableDebugMode, props.visualizeQuery, queryTraceId, totalRows]);

    return (
        <div className={classNames(styles.card, props.className, { [styles.embedded]: props.embedded })}>
            <EntryStatusBar
                status={entryStatus}
                onToggleExpanded={props.onToggleExpanded}
                expanded={props.expanded}
                controls={props.contentId}
                onCancel={entryStatus.indicator === IndicatorStatus.Running ? cancel : undefined}
                cancelLabel="Cancel query"
                actions={props.statusActions}
            />
            <div id={props.contentId} className={styles.content} hidden={props.expanded === false}>
                {enabledTabs.length > 0 && (
                    <VerticalTabs
                        className={styles.tabs}
                        variant={VerticalTabVariant.Stacked}
                        selectedTab={selectedTab}
                        selectTab={tab => selectTab(tab as ScriptDetailsTab)}
                        tabProps={tabProps}
                        tabKeys={tabKeys}
                        tabRenderers={tabRenderers}
                    />
                )}
            </div>
        </div>
    );
};
