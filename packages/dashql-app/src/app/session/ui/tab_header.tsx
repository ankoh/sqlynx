import * as React from 'react';
import * as styles from './tab_header.module.css';

import { QueryExecutionState, QueryExecutionStatus } from '../../connections/query_execution_state.js';
import { useComputationRegistry } from '../../../compute/computation_registry.js';

interface TabHeaderProps {
    title: string;
    detail?: string | null;
    /// When set, the header becomes a clickable navigation target (the feed footer uses this to open
    /// Details). Omitted in Details, where the header is a plain, non-clickable label + count.
    onClick?: () => void;
    /// Optional right-aligned content (e.g. a "delete cached" button). Rendered on both variants; on
    /// the clickable variant the title/count sit in an inner button while the actions sit beside it,
    /// since nesting interactive controls inside a button is invalid.
    actions?: React.ReactNode;
}

/// The header bar shown atop a session tab body: a title with an optional greyish "N of M rows"
/// count. Shared by the feed footer (clickable — opens Details) and the Details tabs (inert), so the
/// two surfaces read identically.
export const TabHeader: React.FC<TabHeaderProps> = ({ title, detail, onClick, actions }) => {
    if (onClick != null) {
        return (
            <div className={styles.tab_header}>
                <button type="button" className={styles.tab_header_clickable_inner} onClick={onClick}>
                    <span className={styles.tab_header_title}>{title}</span>
                    {detail && <span className={styles.tab_header_detail}>{detail}</span>}
                </button>
                {actions && <div className={styles.tab_header_actions}>{actions}</div>}
            </div>
        );
    }
    return (
        <div className={styles.tab_header}>
            <span className={styles.tab_header_title}>{title}</span>
            {detail && <span className={styles.tab_header_detail}>{detail}</span>}
            {actions && <div className={styles.tab_header_actions}>{actions}</div>}
        </div>
    );
};

/// Whether the query produced a materialized result, and its total row count. Shared so the footer's
/// preview and the Details tabs derive the "N rows" detail identically.
export function useResultRowCount(queryState: QueryExecutionState | null): { hasResult: boolean; totalRows: number | null } {
    const computationState = useComputationRegistry()?.[0];
    const hasResult = queryState != null
        && queryState.status === QueryExecutionStatus.SUCCEEDED
        && computationState?.tableComputations[queryState.queryId] != null;
    const totalRows = hasResult
        ? (computationState?.tableComputations[queryState!.queryId]?.dataTable.numRows ?? null)
        : null;
    return { hasResult, totalRows };
}

/// Format a plain "N rows" / "N row" detail string from a total (null when the total is unknown).
export function formatRowCountDetail(totalRows: number | null): string | null {
    if (totalRows == null) return null;
    return `${totalRows} ${totalRows === 1 ? 'row' : 'rows'}`;
}
