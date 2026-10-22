import * as React from 'react';

import type { QueryExecutionState } from '../../../connections/query_execution_state.js';
import { TabHeader, formatRowCountDetail } from '../../../ui/tab_header.js';
import { QueryResultView } from './query_result_view.js';
import { TableColumnHeader } from './data_table_cell.js';
import { classNames } from '../../../../../utils/classnames.js';
import { SET_CROSS_FILTERS } from '../../../../../compute/computation_state.js';
import { CrossFilters } from '../../../../../compute/cross_filters.js';
import { useComputationRegistry } from '../../../../../compute/computation_registry.js';
import { ButtonSize, ButtonVariant, IconButton } from '../../../../../ui/foundations/button.js';
import { SymbolIcon } from '../../../../../ui/foundations/symbol_icon.js';
import * as styles from './query_result_details.module.css';
import { QueryResultToolbar, useQueryResultRowCounts } from './query_result_toolbar.js';
import { QueryResultDownloadButton } from './query_result_download_button.js';

export interface QueryResultDetailsDependencies {
    QueryResultToolbar: typeof QueryResultToolbar;
    QueryResultView: typeof QueryResultView;
    useComputationRegistry(): [
        ReturnType<typeof useComputationRegistry>[0],
        ReturnType<typeof useComputationRegistry>[1],
    ];
    useQueryResultRowCounts: typeof useQueryResultRowCounts;
    QueryResultDownloadButton: typeof QueryResultDownloadButton;
}

const DEFAULT_DEPENDENCIES: QueryResultDetailsDependencies = {
    QueryResultToolbar,
    QueryResultView,
    useComputationRegistry: () => {
        const [state, dispatch] = useComputationRegistry();
        return [state, dispatch];
    },
    useQueryResultRowCounts,
    QueryResultDownloadButton,
};

interface Props {
    query: QueryExecutionState;
    debugMode: boolean;
    actions?: React.ReactNode;
    fitHeight?: boolean;
    maxHeight?: number;
    columnHeader?: TableColumnHeader;
    dependencies?: QueryResultDetailsDependencies;
}

const HEADER_HEIGHT = 32;
const ClearFiltersIcon = SymbolIcon('filter_remove_24');

export const QueryResultDetails: React.FC<Props> = ({ query, debugMode, actions, fitHeight, maxHeight, columnHeader, dependencies = DEFAULT_DEPENDENCIES }) => {
    const searchRows = dependencies.useQueryResultRowCounts(query);
    const [computationState, computationDispatch] = dependencies.useComputationRegistry();
    const QueryResultToolbarComponent = dependencies.QueryResultToolbar;
    const QueryResultViewComponent = dependencies.QueryResultView;
    const QueryResultDownloadButtonComponent = dependencies.QueryResultDownloadButton;
    const tableComputation = computationState.tableComputations[query.queryId] ?? null;
    const hasCrossFilters = tableComputation != null
        && Object.keys(tableComputation.crossFilters.columnFilters).length > 0;
    const clearCrossFilters = React.useCallback(() => {
        computationDispatch({ type: SET_CROSS_FILTERS, value: [query.queryId, new CrossFilters()] });
    }, [computationDispatch, query.queryId]);
    return (
        <div className={classNames(styles.root, { [styles.root_fit_height]: fitHeight })}>
            <TabHeader
                title="Query Results"
                detail={searchRows.matchingRows == null
                    ? formatRowCountDetail(searchRows.totalRows)
                    : `${searchRows.matchingRows} of ${searchRows.currentRows ?? searchRows.totalRows ?? 0} rows`}
                actions={(
                    <>
                        <QueryResultToolbarComponent query={query} />
                        <IconButton
                            variant={ButtonVariant.Invisible}
                            size={ButtonSize.Small}
                            aria-label="Clear all cross-filters"
                            onClick={clearCrossFilters}
                            disabled={!hasCrossFilters}
                        >
                            <ClearFiltersIcon size={16} />
                        </IconButton>
                        <QueryResultDownloadButtonComponent query={query} />
                        {actions}
                    </>
                )}
            />
            <div className={classNames(styles.body, { [styles.body_fit_height]: fitHeight })}>
                <QueryResultViewComponent
                    query={query}
                    debugMode={debugMode}
                    compact
                    fitHeight={fitHeight}
                    maxHeight={maxHeight == null ? undefined : Math.max(0, maxHeight - HEADER_HEIGHT)}
                    columnHeader={columnHeader}
                />
            </div>
        </div>
    );
};
