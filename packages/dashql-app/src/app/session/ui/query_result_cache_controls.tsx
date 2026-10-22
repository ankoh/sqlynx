import * as React from 'react';
import * as styles from './query_result_cache_controls.module.css';

import { SyncIcon } from '../../../ui/foundations/symbol_icon.js';

import { QueryExecutionState, QueryExecutionStatus } from '../connections/query_execution_state.js';
import { useRelativeTime } from '../../../utils/time_format.js';
import { ButtonVariant, IconButton } from '../../../ui/foundations/button.js';

interface QueryResultCacheControlsProps {
    query: QueryExecutionState | null;
}

export const CachedResultBean: React.FC = () => (
    <span className={styles.cached_result_bean}>Cached</span>
);

/// Whether the query has a result to describe (succeeded, not since cache-deleted).
function hasResult(query: QueryExecutionState | null): boolean {
    return query?.status === QueryExecutionStatus.SUCCEEDED && query?.cacheDeleted !== true;
}

/// The timestamp to show as "Executed <relative>": for a cache hit this is the cached entry's write
/// time (the original execution); otherwise it's when this run succeeded (which is "now" right after
/// a cache miss). Falls back to null when neither is available yet.
function executedAtMs(query: QueryExecutionState | null): number | null {
    if (query == null) {
        return null;
    }
    if (query.servedFromCache && query.cachedAt != null) {
        return query.cachedAt.getTime();
    }
    return query.metrics?.querySucceededAt?.getTime() ?? null;
}

/// The execution age label shown in the entry status bar: "Executed <relative time>" (e.g.
/// "Executed 8 minutes ago", "Executed just now"). Shown for any succeeded result regardless of
/// cache hit/miss; a cache hit reports the original execution time, a fresh run reports "now". The
/// relative time refreshes on an interval.
export const QueryResultCacheLabel: React.FC<QueryResultCacheControlsProps> = ({ query }) => {
    const relativeTime = useRelativeTime(executedAtMs(query));
    if (!hasResult(query) || relativeTime == null) {
        return null;
    }
    // Lowercase the first letter so "Just now"/"Yesterday" read naturally after "Executed".
    const relative = relativeTime.charAt(0).toLowerCase() + relativeTime.slice(1);
    return (
        <span className={styles.cache_label}>
            Executed {relative}
        </span>
    );
};

interface QueryResultRerunButtonProps {
    query: QueryExecutionState | null;
    /// Re-execute the query for this result. Receives the current result's cache key (if any) so the
    /// caller can drop the stale entry before re-running.
    onRerun?: (cacheKey: string | null) => void;
}

/// The Refresh icon shown in the entry status bar. Shown for any succeeded result; clicking
/// it drops the cached entry (if any) and re-executes the query against the backend.
export const QueryResultRerunButton: React.FC<QueryResultRerunButtonProps> = ({ query, onRerun }) => {
    if (!hasResult(query)) {
        return null;
    }
    const cacheKey = query?.cacheKey ?? null;
    return (
        <IconButton
            className={styles.rerun_button}
            variant={ButtonVariant.Invisible}
            onClick={onRerun != null ? () => onRerun(cacheKey) : undefined}
            disabled={onRerun == null}
            aria-label="Refresh"
            description="Refresh"
        >
            <SyncIcon size={16} />
        </IconButton>
    );
};
