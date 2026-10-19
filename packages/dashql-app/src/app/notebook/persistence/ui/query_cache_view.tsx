import * as React from 'react';
import * as styles from './query_cache_view.module.css';

import { List, useListCallbackRef } from 'react-window';
import type { RowComponentProps } from 'react-window';
import { XIcon, TrashIcon, SyncIcon } from '../../../../ui/foundations/symbol_icon.js';

import { ButtonVariant, ButtonSize, IconButton } from '../../../../ui/foundations/button.js';
import { CacheFileStat } from '../query_result_cache_eviction.js';
import { STORAGE_CACHE_EXTENSION } from '../storage_backend.js';
import { formatBytes } from '../../../../utils/format.js';
import { formatRelativeTime } from '../../../../utils/time_format.js';
import { observeSize } from '../../../../ui/foundations/size_observer.js';
import { useLogger } from '../../../../platform/logger/logger_provider.js';
import { useStorageReader } from '../storage_provider.js';
import { VerticalScrollShadows } from '../../../../ui/foundations/vertical_scroll_shadows.js';

const LOG_CTX = 'query_cache_view';

export const ROW_HEIGHT = 32;

/// Strip the `.arrow` extension so the row shows the bare content hash (the cache key).
function hashOf(name: string): string {
    return name.endsWith(STORAGE_CACHE_EXTENSION) ? name.slice(0, -STORAGE_CACHE_EXTENSION.length) : name;
}

export interface QueryCacheRowProps {
    entries: CacheFileStat[];
    deleteEntry: (name: string) => void;
}

export const QueryCacheRow = (props: RowComponentProps<QueryCacheRowProps>) => {
    const { entries, deleteEntry } = props;
    const entry = entries[props.index];

    if (!entry) {
        return <div style={props.style} />;
    }

    const hash = hashOf(entry.name);
    return (
        <div className={styles.stat_row} style={props.style}>
            <div className={styles.stat_row_main}>
                <div className={styles.stat_cell_hash} title={hash}>
                    {hash}
                </div>
                <div className={styles.stat_cell_size}>
                    {formatBytes(entry.size)}
                </div>
                <div className={styles.stat_cell_cached} title={new Date(entry.mtimeMs).toISOString()}>
                    {formatRelativeTime(new Date(entry.mtimeMs))}
                </div>
                <div className={styles.stat_cell_accessed} title={new Date(entry.lastAccessMs).toISOString()}>
                    {formatRelativeTime(new Date(entry.lastAccessMs))}
                </div>
                <div className={styles.stat_cell_actions}>
                    <IconButton
                        variant={ButtonVariant.Invisible}
                        size={ButtonSize.Small}
                        aria-label="Delete cache entry"
                        onClick={() => deleteEntry(entry.name)}
                    >
                        <TrashIcon />
                    </IconButton>
                </div>
            </div>
        </div>
    );
};

/// Sort by cached (write) time descending — most recent entries first.
function sortEntries(entries: CacheFileStat[]): CacheFileStat[] {
    return [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function QueryCacheView(props: { notebookId: string | null; onClose: () => void; }) {
    const logger = useLogger();
    const storageReader = useStorageReader();
    const { notebookId } = props;

    const [entries, setEntries] = React.useState<CacheFileStat[]>([]);

    // Load (and reload) the notebook's cache listing. Best-effort: a failure leaves the list empty and
    // is logged, mirroring how the cache itself treats every access as best-effort.
    const refresh = React.useCallback(async () => {
        if (notebookId == null) {
            setEntries([]);
            return;
        }
        try {
            const files = await storageReader.backend.listQueryResultCache(notebookId);
            setEntries(sortEntries(files));
        } catch (e: any) {
            logger.warn('failed to list query result cache', { error: String(e?.message ?? e) }, LOG_CTX);
            setEntries([]);
        }
    }, [notebookId, storageReader, logger]);

    React.useEffect(() => {
        void refresh();
    }, [refresh]);

    const deleteEntry = React.useCallback(async (name: string) => {
        if (notebookId == null) {
            return;
        }
        try {
            await storageReader.backend.deleteQueryResultCache(notebookId, hashOf(name));
        } catch (e: any) {
            logger.warn('failed to delete query result cache entry', { error: String(e?.message ?? e) }, LOG_CTX);
        }
        await refresh();
    }, [notebookId, storageReader, logger, refresh]);

    // Aggregate totals for the header summary.
    const totalBytes = React.useMemo(() => entries.reduce((sum, e) => sum + e.size, 0), [entries]);

    // Container size for the virtual list
    const containerRef = React.useRef<HTMLDivElement>(null);
    const containerSize = observeSize(containerRef);
    const containerWidth = containerSize?.width ?? 200;
    const containerHeight = containerSize?.height ?? 100;

    const [listApi, setListApi] = useListCallbackRef(null);
    const getScrollElement = React.useCallback(() => listApi?.element ?? null, [listApi]);
    const rowProps = React.useMemo<QueryCacheRowProps>(() => ({
        entries,
        deleteEntry,
    }), [entries, deleteEntry]);

    return (
        <div className={styles.overlay}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.title}>Query Cache</div>
                    {entries.length > 0 && (
                        <div className={styles.summary}>
                            {entries.length} {entries.length === 1 ? 'entry' : 'entries'} · {formatBytes(totalBytes)}
                        </div>
                    )}
                </div>
                <div className={styles.header_right_container}>
                    <IconButton
                        variant={ButtonVariant.Invisible}
                        aria-label="Refresh cache listing"
                        onClick={() => void refresh()}
                    >
                        <SyncIcon />
                    </IconButton>
                    <IconButton
                        variant={ButtonVariant.Invisible}
                        aria-label="close-overlay"
                        onClick={props.onClose}
                    >
                        <XIcon />
                    </IconButton>
                </div>
            </div>
            <div className={styles.stat_header_row}>
                <div className={styles.stat_header_main}>
                    <div className={styles.stat_cell_hash}>Key</div>
                    <div className={styles.stat_cell_size}>Size</div>
                    <div className={styles.stat_cell_cached}>Cached</div>
                    <div className={styles.stat_cell_accessed}>Accessed</div>
                    <div className={styles.stat_cell_actions} />
                </div>
            </div>
            <div className={styles.stat_grid_container} ref={containerRef}>
                {entries.length === 0 ? (
                    <div className={styles.empty_state}>
                        {notebookId == null ? 'Select a notebook to see its cached results' : 'Nothing to see here'}
                    </div>
                ) : (
                    <List
                        listRef={setListApi}
                        style={{ width: containerWidth, height: containerHeight }}
                        rowCount={entries.length}
                        rowHeight={ROW_HEIGHT}
                        rowComponent={QueryCacheRow}
                        rowProps={rowProps}
                    />
                )}
                <VerticalScrollShadows
                    getScrollElement={getScrollElement}
                    refreshKey={entries.length}
                />
            </div>
        </div>
    );
}
