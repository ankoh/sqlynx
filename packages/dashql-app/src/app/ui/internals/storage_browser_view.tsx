import * as React from 'react';
import * as styles from './storage_browser_view.module.css';

import { List, useListCallbackRef } from 'react-window';
import type { RowComponentProps } from 'react-window';

import {
    ChevronDownIcon,
    ChevronRightIcon,
    FileDirectoryFillIcon,
    FileDirectoryIcon,
    FileIcon,
    StackCheckIcon,
    SyncIcon,
    XIcon,
} from '../../../ui/foundations/symbol_icon.js';
import { Button, ButtonSize, ButtonVariant, IconButton } from '../../../ui/foundations/button.js';
import { VerticalScrollShadows } from '../../../ui/foundations/vertical_scroll_shadows.js';
import { observeSize } from '../../../ui/foundations/size_observer.js';
import { classNames } from '../../../utils/classnames.js';
import { formatBytes } from '../../../utils/format.js';
import { formatRelativeTime } from '../../../utils/time_format.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import { stringifyError } from '../../../platform/logger/logger.js';
import { useStorageReader, useStorageWriter } from '../../storage/storage_provider.js';
import {
    type OPFSCleanupCandidate,
    type OPFSCleanupResult,
    findOPFSCleanupCandidates,
    removeOPFSCleanupCandidates,
} from '../../storage/opfs_cleanup.js';
import {
    OPFS_TREE_ROOT_KEY,
    StorageTreeEntryKind,
    StorageTreeStatCache,
    listStorageTreeRoots,
    type StorageTreeEntry,
    type StorageTreeFileStat,
    type StorageTreeRoot,
} from '../../storage/storage_tree.js';

const LOG_CTX = 'storage_browser';
/// The height of a row: a 32px entry with 1px of space above and below, as in the catalog tree
const ROW_HEIGHT = 34;
const INDENT_PX = 16;
/// The left padding of an entry at depth 0
const ENTRY_PADDING_PX = 8;
/// The space above the first row, as in the catalog tree
const FIRST_ROW_PADDING_PX = 8;

/// The height of a row, the first row also holds the space above the list
function rowHeight(index: number): number {
    return ROW_HEIGHT + (index === 0 ? FIRST_ROW_PADDING_PX : 0);
}

/// The class of a row container, the first row is padded at the top
function rowContainerClass(index: number): string {
    return classNames(styles.row_container, index === 0 && styles.row_container_first);
}

/// The listing of a directory
export type StorageTreeListing =
    | { status: 'loading' }
    | { status: 'ready'; entries: StorageTreeEntry[] }
    | { status: 'error'; message: string };

/// The key of a node: the root key and the slash-joined path, separated by a NUL that no path contains
export function storageTreeNodeKey(root: StorageTreeRoot, path: string): string {
    return `${root.key}\0${path}`;
}

/// The path segments of a slash-joined path
function splitPath(path: string): string[] {
    return path === '' ? [] : path.split('/');
}

/// A row of the flattened tree
export type StorageTreeRow =
    | { kind: 'root'; key: string; depth: number; root: StorageTreeRoot; expanded: boolean }
    | { kind: 'directory'; key: string; depth: number; root: StorageTreeRoot; path: string; name: string; expanded: boolean }
    | { kind: 'file'; key: string; depth: number; root: StorageTreeRoot; path: string; name: string }
    /// A row in place of the entries of a directory, `load` is set when the listing still has to be requested
    | { kind: 'status'; key: string; depth: number; text: string; error: boolean; load: { root: StorageTreeRoot; path: string } | null };

/// Flatten the expanded and loaded part of the tree into rows
export function flattenStorageTree(
    roots: readonly StorageTreeRoot[],
    expanded: ReadonlySet<string>,
    listings: ReadonlyMap<string, StorageTreeListing>,
): StorageTreeRow[] {
    const rows: StorageTreeRow[] = [];
    const visit = (root: StorageTreeRoot, path: string, depth: number) => {
        const key = storageTreeNodeKey(root, path);
        const listing = listings.get(key);
        const statusKey = `${key}\0status`;
        if (listing == null || listing.status === 'loading') {
            rows.push({ kind: 'status', key: statusKey, depth, text: 'Loading…', error: false, load: listing == null ? { root, path } : null });
            return;
        }
        if (listing.status === 'error') {
            rows.push({ kind: 'status', key: statusKey, depth, text: listing.message, error: true, load: null });
            return;
        }
        if (listing.entries.length === 0) {
            rows.push({ kind: 'status', key: statusKey, depth, text: 'Empty', error: false, load: null });
            return;
        }
        for (const entry of listing.entries) {
            const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
            const childKey = storageTreeNodeKey(root, childPath);
            if (entry.kind === StorageTreeEntryKind.Directory) {
                const isExpanded = expanded.has(childKey);
                rows.push({ kind: 'directory', key: childKey, depth, root, path: childPath, name: entry.name, expanded: isExpanded });
                if (isExpanded) {
                    visit(root, childPath, depth + 1);
                }
            } else {
                rows.push({ kind: 'file', key: childKey, depth, root, path: childPath, name: entry.name });
            }
        }
    };
    for (const root of roots) {
        const key = storageTreeNodeKey(root, '');
        const isExpanded = expanded.has(key);
        rows.push({ kind: 'root', key, depth: 0, root, expanded: isExpanded });
        if (isExpanded) {
            visit(root, '', 1);
        }
    }
    return rows;
}

/// Subscribe to the stat of a file in the stat cache
function useFileStat(cache: StorageTreeStatCache, root: StorageTreeRoot, path: string, key: string): StorageTreeFileStat | null {
    const [stat, setStat] = React.useState<StorageTreeFileStat | null>(() => cache.get(key) ?? null);
    React.useEffect(() => {
        setStat(cache.get(key) ?? null);
        return cache.subscribe(key, () => root.stat(splitPath(path)), setStat);
    }, [cache, root, path, key]);
    return stat;
}

/// The size and modification cells of a file, filled once its stat arrives
function FileStatCells(props: { cache: StorageTreeStatCache; root: StorageTreeRoot; path: string; nodeKey: string }) {
    const stat = useFileStat(props.cache, props.root, props.path, props.nodeKey);
    const modified = stat?.modifiedMs != null ? new Date(stat.modifiedMs) : null;
    return (
        <>
            <div className={styles.cell_size}>
                {stat == null ? null : stat.sizeBytes != null ? formatBytes(stat.sizeBytes) : <span className={styles.note}>{stat.note}</span>}
            </div>
            <div className={styles.cell_modified} title={modified?.toISOString()}>
                {modified != null ? formatRelativeTime(modified) : null}
            </div>
        </>
    );
}

interface StorageTreeRowProps {
    /// The flattened rows
    rows: StorageTreeRow[];
    /// The stats of the files
    statCache: StorageTreeStatCache;
    /// Expand or collapse a directory
    toggle: (key: string) => void;
}

function StorageTreeRowComponent(props: RowComponentProps<StorageTreeRowProps>) {
    const row = props.rows[props.index];
    if (!row) {
        return <div style={props.style} />;
    }
    const indent = { paddingLeft: ENTRY_PADDING_PX + row.depth * INDENT_PX };
    switch (row.kind) {
        case 'root':
        case 'directory': {
            const Chevron = row.expanded ? ChevronDownIcon : ChevronRightIcon;
            return (
                <div className={rowContainerClass(props.index)} style={props.style}>
                    <button
                        type="button"
                        className={classNames(styles.entry, styles.entry_interactive, styles.columns, row.kind === 'root' && styles.root_entry)}
                        style={indent}
                        aria-expanded={row.expanded}
                        onClick={() => props.toggle(row.key)}
                    >
                        <span className={styles.cell_name}>
                            <Chevron size={12} />
                            <span className={styles.icon} aria-hidden="true">
                                {row.kind === 'root' ? <FileDirectoryFillIcon size={14} /> : <FileDirectoryIcon size={14} />}
                            </span>
                            {row.kind === 'root' ? (
                                <span className={styles.root_label}>
                                    <span className={styles.name} title={row.root.label}>{row.root.label}</span>
                                    <span className={styles.root_path} title={row.root.displayPath}>{row.root.displayPath}</span>
                                </span>
                            ) : (
                                <span className={styles.name} title={row.path}>{row.name}</span>
                            )}
                        </span>
                        <span className={styles.cell_size} />
                        <span className={styles.cell_modified} />
                    </button>
                </div>
            );
        }
        case 'file':
            return (
                <div className={rowContainerClass(props.index)} style={props.style}>
                    <div className={classNames(styles.entry, styles.columns)} style={indent}>
                        <span className={styles.cell_name}>
                            <span />
                            <span className={styles.icon} aria-hidden="true"><FileIcon size={14} /></span>
                            <span className={styles.name} title={row.path}>{row.name}</span>
                        </span>
                        <FileStatCells cache={props.statCache} root={row.root} path={row.path} nodeKey={row.key} />
                    </div>
                </div>
            );
        case 'status':
            return (
                <div className={rowContainerClass(props.index)} style={props.style}>
                    <div className={classNames(styles.entry, styles.columns)} style={indent}>
                        <span className={styles.cell_name}>
                            <span />
                            <span className={classNames(styles.status, row.error && styles.status_error)} title={row.text}>{row.text}</span>
                        </span>
                    </div>
                </div>
            );
    }
}

/// The state of a cleanup of the OPFS root
type CleanupState =
    | { status: 'scanning' }
    /// The candidates wait for the user to confirm or cancel the deletion
    | { status: 'review'; candidates: OPFSCleanupCandidate[] }
    | { status: 'deleting'; candidates: OPFSCleanupCandidate[] }
    | { status: 'done'; message: string; error: boolean };

interface CleanupRowProps {
    /// The entries that would be deleted
    candidates: OPFSCleanupCandidate[];
}

function CleanupRowComponent(props: RowComponentProps<CleanupRowProps>) {
    const candidate = props.candidates[props.index];
    if (!candidate) {
        return <div style={props.style} />;
    }
    const path = `${candidate.path.join('/')}${candidate.directory ? '/' : ''}`;
    return (
        <div className={rowContainerClass(props.index)} style={props.style}>
            <div className={classNames(styles.entry, styles.cleanup_columns)}>
                <span className={styles.cleanup_cell_name}>
                    <span className={styles.icon} aria-hidden="true">{candidate.directory ? <FileDirectoryIcon size={14} /> : <FileIcon size={14} />}</span>
                    <span className={styles.name} title={path}>{path}</span>
                </span>
                <span className={styles.reason} title={candidate.reason}>{candidate.reason}</span>
            </div>
        </div>
    );
}

/// Summarize the outcome of a cleanup
function describeCleanupResult(result: OPFSCleanupResult): string {
    const removed = `Deleted ${result.removed} ${result.removed === 1 ? 'entry' : 'entries'}.`;
    if (result.skipped.length === 0) {
        return removed;
    }
    const kept = result.skipped.map(entry => `${entry.path} (${entry.reason})`).join(', ');
    return `${removed} Kept ${result.skipped.length}: ${kept}`;
}

/// A read-only browser of the folders the storage backend knows about: the OPFS root and, on desktop,
/// the native session folders. Directories are listed when expanded, file stats are fetched for the
/// visible rows only.
export function StorageBrowserView(props: { onClose: () => void }) {
    const storageReader = useStorageReader();
    const storageWriter = useStorageWriter();
    const logger = useLogger();

    const [roots, setRoots] = React.useState<StorageTreeRoot[]>(() => listStorageTreeRoots(storageReader));
    const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set([`${OPFS_TREE_ROOT_KEY}\0`]));
    const [listings, setListings] = React.useState<Map<string, StorageTreeListing>>(() => new Map());
    const [statCache, setStatCache] = React.useState(() => new StorageTreeStatCache());

    // Listings that arrive after a refresh are dropped
    const generation = React.useRef(0);

    const rows = React.useMemo(() => flattenStorageTree(roots, expanded, listings), [roots, expanded, listings]);

    // Request the listings of expanded directories that are visible but not loaded yet
    React.useEffect(() => {
        const pending = rows.flatMap(row => row.kind === 'status' && row.load != null ? [row.load] : []);
        if (pending.length === 0) {
            return;
        }
        const current = generation.current;
        setListings(prev => {
            const next = new Map(prev);
            for (const { root, path } of pending) {
                next.set(storageTreeNodeKey(root, path), { status: 'loading' });
            }
            return next;
        });
        for (const { root, path } of pending) {
            const key = storageTreeNodeKey(root, path);
            root.list(splitPath(path)).then(
                (entries): StorageTreeListing => ({ status: 'ready', entries }),
                (error): StorageTreeListing => ({ status: 'error', message: (error as Error)?.message ?? String(error) }),
            ).then(listing => {
                if (current === generation.current) {
                    setListings(prev => new Map(prev).set(key, listing));
                }
            });
        }
    }, [rows]);

    const toggle = React.useCallback((key: string) => {
        setExpanded(prev => {
            const next = new Set(prev);
            if (!next.delete(key)) {
                next.add(key);
            }
            return next;
        });
    }, []);

    // Drop all listings and stats, the visible expanded directories are listed again
    const refresh = React.useCallback(() => {
        ++generation.current;
        setRoots(listStorageTreeRoots(storageReader));
        setListings(new Map());
        setStatCache(new StorageTreeStatCache());
    }, [storageReader]);

    // Find the OPFS entries the current version doesn't use, the deletion waits for the user to confirm
    const [cleanup, setCleanup] = React.useState<CleanupState | null>(null);
    const startCleanup = React.useCallback(async () => {
        setCleanup({ status: 'scanning' });
        try {
            // Pending writes may register new sessions and connections
            await storageWriter.flush();
            const candidates = await findOPFSCleanupCandidates(await navigator.storage.getDirectory());
            setCleanup(candidates.length === 0
                ? { status: 'done', message: 'Nothing to clean up.', error: false }
                : { status: 'review', candidates });
        } catch (error) {
            logger.error('Failed to scan the OPFS for cleanup', { error: stringifyError(error) }, LOG_CTX);
            setCleanup({ status: 'done', message: `Scan failed: ${(error as Error)?.message ?? String(error)}`, error: true });
        }
    }, [storageWriter, logger]);
    const confirmCleanup = React.useCallback(async (candidates: OPFSCleanupCandidate[]) => {
        setCleanup({ status: 'deleting', candidates });
        try {
            const result = await removeOPFSCleanupCandidates(await navigator.storage.getDirectory(), candidates);
            logger.info('Cleaned up the OPFS', {
                removed: result.removed.toString(),
                skipped: result.skipped.length.toString(),
            }, LOG_CTX);
            setCleanup({ status: 'done', message: describeCleanupResult(result), error: result.skipped.length > 0 });
        } catch (error) {
            logger.error('Failed to clean up the OPFS', { error: stringifyError(error) }, LOG_CTX);
            setCleanup({ status: 'done', message: `Cleanup failed: ${(error as Error)?.message ?? String(error)}`, error: true });
        }
        refresh();
    }, [logger, refresh]);
    const reviewing = cleanup?.status === 'review' || cleanup?.status === 'deleting' ? cleanup.candidates : null;
    const cleanupBusy = cleanup?.status === 'scanning' || cleanup?.status === 'deleting';

    const sessionFolders = roots.length - 1;

    // Container size for the virtual list
    const containerRef = React.useRef<HTMLDivElement>(null);
    const containerSize = observeSize(containerRef);
    const containerWidth = containerSize?.width ?? 200;
    const containerHeight = containerSize?.height ?? 100;

    const [listApi, setListApi] = useListCallbackRef(null);
    const getScrollElement = React.useCallback(() => listApi?.element ?? null, [listApi]);
    const rowProps = React.useMemo<StorageTreeRowProps>(() => ({ rows, statCache, toggle }), [rows, statCache, toggle]);
    const cleanupRowProps = React.useMemo<CleanupRowProps>(() => ({ candidates: reviewing ?? [] }), [reviewing]);

    return (
        <div className={styles.overlay}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.title}>Storage</div>
                    {sessionFolders > 0 && (
                        <div className={styles.summary}>
                            {sessionFolders} {sessionFolders === 1 ? 'session folder' : 'session folders'}
                        </div>
                    )}
                </div>
                <div className={styles.header_right_container}>
                    <IconButton
                        variant={ButtonVariant.Invisible}
                        aria-label="Check the filesystem"
                        title="Check the filesystem for entries this version of DashQL doesn't use"
                        disabled={cleanupBusy || reviewing != null}
                        onClick={() => void startCleanup()}
                    >
                        <StackCheckIcon />
                    </IconButton>
                    <IconButton
                        variant={ButtonVariant.Invisible}
                        aria-label="Refresh storage listing"
                        disabled={reviewing != null}
                        onClick={refresh}
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
            <div className={styles.cleanup_bar_row}>
                {cleanup?.status === 'scanning' && (
                    <div className={styles.cleanup_bar}>
                        <div className={styles.cleanup_message}>Checking the filesystem…</div>
                    </div>
                )}
                {reviewing != null && (
                    <div className={styles.cleanup_bar}>
                        <div className={styles.cleanup_message}>
                            Delete {reviewing.length} {reviewing.length === 1 ? 'entry' : 'entries'} that this version of DashQL doesn't use?
                        </div>
                        <Button
                            size={ButtonSize.Small}
                            disabled={cleanup?.status === 'deleting'}
                            onClick={() => setCleanup(null)}
                        >
                            No
                        </Button>
                        <Button
                            size={ButtonSize.Small}
                            variant={ButtonVariant.Danger}
                            disabled={cleanup?.status === 'deleting'}
                            onClick={() => void confirmCleanup(reviewing)}
                        >
                            {cleanup?.status === 'deleting' ? 'Deleting…' : 'Yes, delete'}
                        </Button>
                    </div>
                )}
                {cleanup?.status === 'done' && (
                    <div className={styles.cleanup_bar}>
                        <div className={`${styles.cleanup_message} ${cleanup.error ? styles.cleanup_message_warning : ''}`} title={cleanup.message}>
                            {cleanup.message}
                        </div>
                        <IconButton
                            variant={ButtonVariant.Invisible}
                            size={ButtonSize.Small}
                            aria-label="Dismiss cleanup message"
                            onClick={() => setCleanup(null)}
                        >
                            <XIcon />
                        </IconButton>
                    </div>
                )}
            </div>
            <div className={styles.column_header_row}>
                {reviewing != null ? (
                    <div className={classNames(styles.header_columns, styles.cleanup_columns)}>
                        <div>Entry</div>
                        <div>Reason</div>
                    </div>
                ) : (
                    <div className={classNames(styles.header_columns, styles.columns)}>
                        <div>Name</div>
                        <div className={styles.cell_size}>Size</div>
                        <div className={styles.cell_modified}>Modified</div>
                    </div>
                )}
            </div>
            <div className={styles.list_container} ref={containerRef}>
                {reviewing != null ? (
                    <List
                        listRef={setListApi}
                        style={{ width: containerWidth, height: containerHeight }}
                        rowCount={reviewing.length}
                        rowHeight={rowHeight}
                        rowComponent={CleanupRowComponent}
                        rowProps={cleanupRowProps}
                    />
                ) : (
                    <List
                        listRef={setListApi}
                        style={{ width: containerWidth, height: containerHeight }}
                        rowCount={rows.length}
                        rowHeight={rowHeight}
                        rowComponent={StorageTreeRowComponent}
                        rowProps={rowProps}
                    />
                )}
                <VerticalScrollShadows
                    getScrollElement={getScrollElement}
                    refreshKey={reviewing != null ? -reviewing.length : rows.length}
                />
            </div>
        </div>
    );
}
