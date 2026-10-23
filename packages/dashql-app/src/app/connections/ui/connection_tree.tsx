import * as React from 'react';
import * as core from '@ankoh/dashql-core';
import symbols from '@ankoh/dashql-svg-symbols';
import { List, type RowComponentProps, useListRef } from 'react-window';

import * as ActionList from '../../../ui/foundations/action_list.js';
import { AnchorAlignment, AnchorSide } from '../../../ui/foundations/anchored_position.js';
import { AnchoredOverlay } from '../../../ui/foundations/anchored_overlay.js';
import { ButtonSize, ButtonVariant, IconButton } from '../../../ui/foundations/button.js';
import { IndicatorStatus, StatusIndicator } from '../../../ui/foundations/status_indicator.js';
import { observeSize } from '../../../ui/foundations/size_observer.js';
import { VerticalScrollShadows } from '../../../ui/foundations/vertical_scroll_shadows.js';
import {
    ChevronDownIcon,
    ChevronRightIcon,
    DatabaseIcon,
    FileDirectoryIcon,
    SymbolIcon,
    SyncIcon,
    TableIcon,
    TrashIcon,
} from '../../../ui/foundations/symbol_icon.js';
import { classNames } from '../../../utils/classnames.js';
import { ConnectionHealth, type ConnectionState } from '../connection_state.js';
import { isListedConnection, type ConnectionReferences, type ConnectionRegistry, type ResolvedSessionConnections } from '../connection_registry.js';
import { useCatalogLoaderQueue } from '../catalog_loader.js';
import { isCatalogRefreshRunning } from '../catalog_update_state.js';
import { canRefreshConnection } from './connection_refresh.js';
import { CONNECTION_HEALTH_COLORS, CONNECTION_HEALTH_NAMES } from './connection_status.js';
import { connectionLabelParts, connectionLabelText, isHyperWasmConnection, type ConnectionLabelParts } from './connection_label.js';
import { ConnectionLabelView } from './connection_label_view.js';
import * as styles from './connection_tree.module.css';
import * as actionMenuStyles from '../../ui/action_menu.module.css';

const MoreIcon = SymbolIcon('kebab_horizontal');
const ColumnsIcon = SymbolIcon('columns_16');
const SettingsIcon = SymbolIcon('settings_16');
const PencilIcon = SymbolIcon('pencil_16');

export interface CatalogNode {
    key: string;
    name: string;
    kind: 'database' | 'schema' | 'table' | 'column';
    index: number;
    childBegin: number;
    childCount: number;
}

interface CatalogRow extends CatalogNode {
    type: 'catalog';
    depth: number;
}

interface ConnectionListRow {
    type: 'connection';
    key: string;
    database: ConnectionState;
}

/// The heading of a group of connections
interface ConnectionGroupRow {
    /// The row type
    type: 'connection-group';
    /// The row key
    key: string;
    /// The heading
    label: string;
}

type ConnectionTreeRow = ConnectionGroupRow | ConnectionListRow | CatalogRow;

const CONNECTION_ROW_HEIGHT = 38;
const CATALOG_ROW_HEIGHT = 34;
const CONNECTION_GROUP_ROW_HEIGHT = 26;

export function isVisibleCatalogNode(kind: CatalogNode['kind'], name: string): boolean {
    return (kind !== 'database' && kind !== 'schema') || name.trim().length > 0;
}

function readCatalogNode(
    reader: core.DashQLCatalogSnapshotReader,
    level: CatalogNode['kind'],
    index: number,
    parentKey: string,
): CatalogNode | null {
    const catalog = reader.catalogReader;
    const entry = new core.buffers.catalog.FlatCatalogEntry();
    const value = level === 'database'
        ? catalog.databases(index, entry)
        : level === 'schema'
            ? catalog.schemas(index, entry)
            : level === 'table'
                ? catalog.tables(index, entry)
                : catalog.columns(index, entry);
    if (value == null) return null;

    const name = reader.readName(value.nameId());
    if (!isVisibleCatalogNode(level, name)) return null;
    const key = `${parentKey}/${level}:${index}:${name}`;
    return {
        key,
        name,
        kind: level,
        index,
        childBegin: value.childBegin(),
        childCount: value.childCount(),
    };
}

function catalogLevelLength(reader: core.DashQLCatalogSnapshotReader, level: CatalogNode['kind']): number {
    const catalog = reader.catalogReader;
    switch (level) {
        case 'database': return catalog.databasesLength();
        case 'schema': return catalog.schemasLength();
        case 'table': return catalog.tablesLength();
        case 'column': return catalog.columnsLength();
    }
}

function nextCatalogLevel(level: CatalogNode['kind']): CatalogNode['kind'] | null {
    switch (level) {
        case 'database': return 'schema';
        case 'schema': return 'table';
        case 'table': return 'column';
        case 'column': return null;
    }
}

export function createCatalogTree(reader: core.DashQLCatalogSnapshotReader, parentKey = 'catalog'): CatalogNode[] {
    const nodes: CatalogNode[] = [];
    for (let index = 0; index < reader.catalogReader.databasesLength(); ++index) {
        const node = readCatalogNode(reader, 'database', index, parentKey);
        if (node != null) nodes.push(node);
    }
    return nodes;
}

export function flattenCatalogRows(
    reader: core.DashQLCatalogSnapshotReader,
    roots: CatalogNode[],
    expanded: ReadonlySet<string>,
): CatalogRow[] {
    const rows: CatalogRow[] = [];
    const append = (node: CatalogNode, depth: number) => {
        rows.push({ ...node, type: 'catalog', depth });
        const nextLevel = nextCatalogLevel(node.kind);
        if (nextLevel == null || node.childCount === 0 || !expanded.has(node.key)) return;
        const end = Math.min(node.childBegin + node.childCount, catalogLevelLength(reader, nextLevel));
        for (let index = node.childBegin; index < end; ++index) {
            const child = readCatalogNode(reader, nextLevel, index, node.key);
            if (child != null) append(child, depth + 1);
        }
    };
    for (const root of roots) append(root, 0);
    return rows;
}

function catalogIcon(kind: CatalogNode['kind']): React.ReactElement {
    switch (kind) {
        case 'database': return <DatabaseIcon size={14} />;
        case 'schema': return <FileDirectoryIcon size={14} />;
        case 'table': return <TableIcon size={14} />;
        case 'column': return <ColumnsIcon size={14} />;
    }
}

interface ConnectionTreeEntryProps {
    name: string;
    /// The rendered name, the plain name by default
    label?: React.ReactNode;
    icon: React.ReactNode;
    depth: number;
    expanded?: boolean;
    onToggle?: () => void;
    children?: React.ReactNode;
    className?: string;
}

const ConnectionTreeEntry: React.FC<ConnectionTreeEntryProps> = ({
    name,
    label,
    icon,
    depth,
    expanded,
    onToggle,
    children,
    className,
}) => {
    const collapsible = onToggle != null;
    return (
        <div
            className={classNames(styles.entry_surface, collapsible && styles.entry_interactive, styles.tree_entry, className)}
            style={{ paddingLeft: `${8 + depth * 16}px` }}
        >
            {collapsible ? (
                <button
                    type="button"
                    className={classNames(styles.tree_entry_main, styles.tree_entry_toggle)}
                    aria-expanded={expanded}
                    aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name}`}
                    onClick={onToggle}
                >
                    {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                    <span className={styles.tree_entry_icon} aria-hidden="true">{icon}</span>
                    <span className={styles.tree_entry_name}>{label ?? name}</span>
                </button>
            ) : (
                <div className={styles.tree_entry_main}>
                    <span className={styles.tree_entry_spacer} />
                    <span className={styles.tree_entry_icon} aria-hidden="true">{icon}</span>
                    <span className={styles.tree_entry_name}>{label ?? name}</span>
                </div>
            )}
            {children != null && <span className={styles.tree_entry_children}>{children}</span>}
        </div>
    );
};

interface ConnectionTreeRowProps {
    rows: ConnectionTreeRow[];
    expanded: ReadonlySet<string>;
    onToggle: (key: string) => void;
    onOpenSettings: (connectionId: string, anchor: HTMLButtonElement, focusName?: boolean) => void;
    describeUsage?: (connectionId: string) => ConnectionUsage;
    onDelete?: (connectionId: string) => void;
    labelOf: (database: ConnectionState) => ConnectionLabelParts;
    attention: boolean;
}

/// How sessions use a connection
export interface ConnectionUsage {
    /// The number of sessions that use the connection
    sessionCount: number;
    /// Does the current session use the connection?
    usedHere: boolean;
}

export function connectionTreeRowHeight(index: number, props: Pick<ConnectionTreeRowProps, 'rows'>): number {
    switch (props.rows[index]?.type) {
        case 'connection-group':
            return CONNECTION_GROUP_ROW_HEIGHT + (index === 0 ? 4 : 0);
        case 'connection':
            return CONNECTION_ROW_HEIGHT + (index === 0 ? 8 : 0);
        default:
            return CATALOG_ROW_HEIGHT;
    }
}

const ConnectionTreeRow = (props: RowComponentProps<ConnectionTreeRowProps>) => {
    const row = props.rows[props.index];
    if (row == null) return <div style={props.style} />;
    if (row.type === 'connection-group') {
        return (
            <div
                style={props.style}
                className={classNames(styles.connection_group_row, props.index === 0 && styles.connection_group_row_first)}
                role="heading"
                aria-level={3}
            >
                {row.label}
            </div>
        );
    }
    if (row.type === 'connection') {
        const expanded = props.expanded.has(row.key);
        const labelParts = props.labelOf(row.database);
        const label = connectionLabelText(labelParts);
        const usage = props.describeUsage?.(row.database.connectionId) ?? null;
        return (
            <div
                style={props.style}
                className={classNames(
                    styles.tree_row_container,
                    styles.database_row_container,
                    props.index === 0 && styles.database_row_container_first,
                )}
            >
                <ConnectionTreeEntry
                    className={styles.database_row}
                    name={label}
                    label={<ConnectionLabelView parts={labelParts} />}
                    depth={0}
                    expanded={expanded}
                    onToggle={() => props.onToggle(row.key)}
                    icon={(
                        <svg width="14" height="14">
                            <use xlinkHref={`${symbols}#${row.database.connectorInfo.icons.colored}`} />
                        </svg>
                    )}
                >
                    {usage != null && usage.sessionCount === 0 && (
                        <span className={styles.catalog_node_kind} title="No session uses this connection">unused</span>
                    )}
                    <ConnectionStatusButton
                        database={row.database}
                        label={label}
                        usedHere={usage?.usedHere ?? false}
                        attention={props.attention}
                        onOpenSettings={anchor => props.onOpenSettings(row.database.connectionId, anchor)}
                    />
                    <ConnectionRefreshButton database={row.database} label={label} />
                    <ConnectionRowMenu
                        database={row.database}
                        label={label}
                        onOpenSettings={anchor => props.onOpenSettings(row.database.connectionId, anchor)}
                        onRename={anchor => props.onOpenSettings(row.database.connectionId, anchor, true)}
                        onDelete={props.onDelete == null || usage == null ? undefined : () => props.onDelete!(row.database.connectionId)}
                        sessionCount={usage?.sessionCount}
                    />
                </ConnectionTreeEntry>
            </div>
        );
    }
    const node = row;
    const expandable = node.childCount > 0;
    const expanded = props.expanded.has(node.key);
    return (
        <div style={props.style} className={styles.tree_row_container}>
            <ConnectionTreeEntry
                className={styles.catalog_row}
                name={node.name || 'Unnamed'}
                icon={catalogIcon(node.kind)}
                depth={node.depth + 1}
                expanded={expanded}
                onToggle={expandable ? () => props.onToggle(node.key) : undefined}
            >
                <span className={styles.catalog_node_kind}>{node.kind}</span>
            </ConnectionTreeEntry>
        </div>
    );
};

interface ConnectionTreeProps {
    databases: ConnectionState[];
    /// Open the settings of a connection, focusing its name to rename it
    onOpenSettings: (connectionId: string, anchor: HTMLButtonElement, focusName?: boolean) => void;
    /// Describe how sessions use a connection
    describeUsage?: (connectionId: string) => ConnectionUsage;
    /// Delete a connection that no session uses
    onDelete?: (connectionId: string) => void;
    /// Is a connection expanded initially?
    initiallyExpanded?: (database: ConnectionState, databaseCount: number) => boolean;
    /// The connections of the current session, they are grouped apart from the other connections
    sessionConnectionIds?: ReadonlySet<string>;
    /// Label a connection
    labelOf?: (database: ConnectionState) => ConnectionLabelParts;
    /// Does the current session ask for its connections to execute?
    attention?: boolean;
}

const connectionKey = (connectionId: string) => `connection:${connectionId}`;

/// The groups of the connection tree
type ConnectionGroupKind = 'session' | 'other';

/// The headings of the groups of the connection tree
const CONNECTION_GROUP_LABELS: Record<ConnectionGroupKind, string> = {
    session: 'This session',
    other: 'Other connections',
};

const defaultConnectionLabelOf = (database: ConnectionState) => connectionLabelParts(database);

/// Keep the identity of an array as long as its elements are identical
function useShallowStableArray<T>(values: T[]): T[] {
    const ref = React.useRef(values);
    if (ref.current.length !== values.length || ref.current.some((value, i) => value !== values[i])) {
        ref.current = values;
    }
    return ref.current;
}

export const ConnectionTree: React.FC<ConnectionTreeProps> = ({
    databases,
    onOpenSettings,
    describeUsage,
    onDelete,
    initiallyExpanded = isConnectionInitiallyExpanded,
    sessionConnectionIds,
    labelOf = defaultConnectionLabelOf,
    attention = false,
}) => {
    // The database states change with every query event while the catalogs rarely change.
    // A catalog caches its snapshot until it is modified (which destroys the snapshot), so the snapshot identity
    // tells us when the trees must be rebuilt. Never keep a reader of a snapshot that is no longer current.
    const connectionIds = useShallowStableArray(databases.map(database => database.connectionId));
    const snapshots = useShallowStableArray(databases.map(database => database.catalog.createSnapshot()));
    const catalogTrees = React.useMemo(() => connectionIds.map((connectionId, i) => {
        const reader = snapshots[i].read();
        return {
            connectionId,
            reader,
            roots: createCatalogTree(reader, `${connectionKey(connectionId)}/catalog`),
        };
    }), [connectionIds, snapshots]);
    const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => {
        const initial = new Set<string>();
        catalogTrees.forEach((tree, i) => {
            if (!initiallyExpanded(databases[i], databases.length)) return;
            initial.add(connectionKey(tree.connectionId));
            for (const root of tree.roots) initial.add(root.key);
        });
        return initial;
    });
    const knownConnectionIds = React.useRef(new Set(connectionIds));
    React.useEffect(() => {
        const nextConnectionIds = new Set(connectionIds);
        setExpanded(current => {
            const next = new Set([...current].filter(key => {
                const connectionId = key.split(':', 2)[1]?.split('/', 1)[0];
                return connectionId == null || nextConnectionIds.has(connectionId);
            }));
            catalogTrees.forEach((tree, i) => {
                if (knownConnectionIds.current.has(tree.connectionId)) return;
                if (initiallyExpanded(databases[i], databases.length)) {
                    next.add(connectionKey(tree.connectionId));
                    for (const root of tree.roots) next.add(root.key);
                }
            });
            return next;
        });
        knownConnectionIds.current = nextConnectionIds;
    }, [connectionIds]);
    const catalogRows = React.useMemo(() => catalogTrees.map(tree => (
        expanded.has(connectionKey(tree.connectionId))
            ? flattenCatalogRows(tree.reader, tree.roots, expanded)
            : []
    )), [catalogTrees, expanded]);
    const rows = React.useMemo(() => {
        const next: ConnectionTreeRow[] = [];
        let group: ConnectionGroupKind | null = null;
        databases.forEach((database, i) => {
            if (sessionConnectionIds != null) {
                const databaseGroup: ConnectionGroupKind = sessionConnectionIds.has(database.connectionId) ? 'session' : 'other';
                if (databaseGroup !== group) {
                    group = databaseGroup;
                    next.push({ type: 'connection-group', key: `connection-group:${group}`, label: CONNECTION_GROUP_LABELS[group] });
                }
            }
            next.push({ type: 'connection', key: connectionKey(database.connectionId), database });
            next.push(...catalogRows[i]);
        });
        return next;
    }, [databases, catalogRows, sessionConnectionIds]);
    const containerRef = React.useRef<HTMLDivElement>(null);
    const size = observeSize(containerRef);
    const listRef = useListRef(null);
    const getScrollElement = React.useCallback(() => listRef.current?.element ?? null, [listRef]);
    const toggle = React.useCallback((key: string) => {
        setExpanded(current => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }, []);
    const rowProps = React.useMemo<ConnectionTreeRowProps>(() => ({
        rows,
        expanded,
        onToggle: toggle,
        onOpenSettings,
        describeUsage,
        onDelete,
        labelOf,
        attention,
    }), [attention, describeUsage, expanded, labelOf, onDelete, onOpenSettings, rows, toggle]);
    return (
        <div ref={containerRef} className={styles.database_list} aria-label="Connections and catalogs">
            <List
                listRef={listRef}
                style={{ width: size?.width ?? 200, height: size?.height ?? 200 }}
                rowCount={rows.length}
                rowHeight={connectionTreeRowHeight}
                rowComponent={ConnectionTreeRow}
                rowProps={rowProps}
            />
            <VerticalScrollShadows getScrollElement={getScrollElement} refreshKey={rows.length} />
        </div>
    );
};

export function connectionDisplayOrder(attached: ResolvedSessionConnections): ConnectionState[] {
    return [attached.main, ...attached.attached];
}

/// The connections shown next to the sessions.
/// The connections of the current session come first, followed by the connections of other
/// sessions and active connections that no session uses.
export function listedConnections(
    registry: Pick<ConnectionRegistry, 'connections'>,
    references: ConnectionReferences,
    currentSessionConnections: readonly ConnectionState[],
): ConnectionState[] {
    const listed = [...currentSessionConnections];
    const seen = new Set(listed.map(database => database.connectionId));
    for (const [connectionId, database] of registry.connections) {
        if (!seen.has(connectionId) && isListedConnection(registry, references, connectionId)) {
            listed.push(database);
        }
    }
    return listed;
}

export function isConnectionInitiallyExpanded(database: ConnectionState, databaseCount: number): boolean {
    return databaseCount === 1 || !isHyperWasmConnection(database);
}

interface ConnectionRowMenuProps {
    database: ConnectionState;
    label: string;
    onOpenSettings: (anchor: HTMLButtonElement) => void;
    /// Open the settings of the connection to rename it
    onRename?: (anchor: HTMLButtonElement) => void;
    /// Delete the connection, only possible if no session uses it
    onDelete?: () => void;
    /// The number of sessions that use the connection
    sessionCount?: number;
    dependencies?: ConnectionRefreshDependencies;
}

export interface ConnectionRefreshDependencies {
    useCatalogLoaderQueue: typeof useCatalogLoaderQueue;
}

const DEFAULT_CONNECTION_REFRESH_DEPENDENCIES: ConnectionRefreshDependencies = {
    useCatalogLoaderQueue,
};

export const ConnectionRowMenu: React.FC<ConnectionRowMenuProps> = ({ database, label, onOpenSettings, onRename, onDelete, sessionCount = 0, dependencies = DEFAULT_CONNECTION_REFRESH_DEPENDENCIES }) => {
    const [open, setOpen] = React.useState(false);
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const refreshCatalog = dependencies.useCatalogLoaderQueue();
    const isRefreshing = isCatalogRefreshRunning(database);
    const canRefresh = canRefreshConnection(database);

    return (
        <AnchoredOverlay
            open={open}
            onOpen={() => setOpen(true)}
            onClose={() => setOpen(false)}
            anchorRef={triggerRef}
            returnFocusRef={triggerRef}
            side={AnchorSide.OutsideRight}
            align={AnchorAlignment.Start}
            anchorOffset={4}
            renderAnchor={(anchorProps) => (
                <IconButton
                    {...anchorProps}
                    ref={triggerRef}
                    size={ButtonSize.Small}
                    variant={ButtonVariant.Invisible}
                    className={styles.database_menu_button}
                    aria-label={`More actions for ${label}`}
                    onClick={(event) => {
                        event.stopPropagation();
                        anchorProps.onClick?.(event);
                    }}
                >
                    <MoreIcon size={14} />
                </IconButton>
            )}
        >
            <div className={actionMenuStyles.menu} role="dialog" aria-label={`Actions for ${label}`}>
                <ActionList.List aria-label={`Actions for ${label}`}>
                    <ActionList.ListItem onClick={() => {
                        const anchor = triggerRef.current;
                        setOpen(false);
                        if (anchor != null) onOpenSettings(anchor);
                    }}>
                        <ActionList.Leading><SettingsIcon size={16} /></ActionList.Leading>
                        <ActionList.ItemText>Settings</ActionList.ItemText>
                    </ActionList.ListItem>
                    {/* The list takes elements only, the fragment wraps the optional item */}
                    <>{onRename && (
                        <ActionList.ListItem onClick={() => {
                            const anchor = triggerRef.current;
                            setOpen(false);
                            if (anchor != null) onRename(anchor);
                        }}>
                            <ActionList.Leading><PencilIcon size={16} /></ActionList.Leading>
                            <ActionList.ItemText>Rename…</ActionList.ItemText>
                        </ActionList.ListItem>
                    )}</>
                    <ActionList.ListItem
                        disabled={!canRefresh}
                        aria-busy={isRefreshing}
                        onClick={() => {
                            setOpen(false);
                            refreshCatalog(database.connectionId, true);
                        }}
                    >
                        <ActionList.Leading>
                            {isRefreshing
                                ? <StatusIndicator status={IndicatorStatus.Running} width="16px" height="16px" />
                                : <SyncIcon size={16} />}
                        </ActionList.Leading>
                        <ActionList.ItemText>Refresh</ActionList.ItemText>
                    </ActionList.ListItem>
                    {/* The list takes elements only, the fragment wraps the optional item */}
                    <>{onDelete && (
                        <ActionList.ListItem
                            className={actionMenuStyles.delete_action}
                            disabled={sessionCount > 0}
                            title={sessionCount > 0 ? `Used by ${sessionCount} ${sessionCount === 1 ? 'session' : 'sessions'}` : undefined}
                            onClick={() => {
                                setOpen(false);
                                onDelete();
                            }}
                        >
                            <ActionList.Leading><TrashIcon size={16} /></ActionList.Leading>
                            <ActionList.ItemText>
                                <ActionList.ItemTextTitle>Delete</ActionList.ItemTextTitle>
                                {sessionCount > 0
                                    ? <ActionList.ItemTextDescription>{`Used by ${sessionCount} ${sessionCount === 1 ? 'session' : 'sessions'}`}</ActionList.ItemTextDescription>
                                    : <></>}
                            </ActionList.ItemText>
                        </ActionList.ListItem>
                    )}</>
                </ActionList.List>
            </div>
        </AnchoredOverlay>
    );
};

interface ConnectionRefreshButtonProps {
    database: ConnectionState;
    label: string;
    dependencies?: ConnectionRefreshDependencies;
}

export const ConnectionRefreshButton: React.FC<ConnectionRefreshButtonProps> = ({ database, label, dependencies = DEFAULT_CONNECTION_REFRESH_DEPENDENCIES }) => {
    const refreshCatalog = dependencies.useCatalogLoaderQueue();
    const isRefreshing = isCatalogRefreshRunning(database);
    const canRefresh = canRefreshConnection(database);

    return (
        <IconButton
            size={ButtonSize.Small}
            variant={ButtonVariant.Invisible}
            className={styles.database_refresh_button}
            aria-label={`Refresh catalog for ${label}`}
            aria-busy={isRefreshing}
            disabled={!canRefresh}
            onClick={() => refreshCatalog(database.connectionId, true)}
        >
            {isRefreshing
                ? <StatusIndicator status={IndicatorStatus.Running} width="14px" height="14px" />
                : <SyncIcon size={14} />}
        </IconButton>
    );
};

interface ConnectionStatusButtonProps {
    /// The connection
    database: ConnectionState;
    /// The label of the connection
    label: string;
    /// Does the current session use the connection?
    usedHere: boolean;
    /// Does the current session ask for its connections to execute?
    attention?: boolean;
    /// Open the settings of the connection
    onOpenSettings: (anchor: HTMLButtonElement) => void;
}

/// The health of a connection, opens its settings.
/// Pulses while the current session asks for a connection to execute and the connection is not online.
export const ConnectionStatusButton: React.FC<ConnectionStatusButtonProps> = ({ database, label, usedHere, attention = false, onOpenSettings }) => {
    const health = database.connectionHealth;
    const online = health === ConnectionHealth.ONLINE;
    const pulse = usedHere && !online && attention;
    return (
        <IconButton
            size={ButtonSize.Small}
            variant={ButtonVariant.Invisible}
            className={classNames(styles.database_status_button, pulse && styles.database_status_attention)}
            data-connection-attention={pulse ? 'true' : undefined}
            aria-label={`${label}: ${CONNECTION_HEALTH_NAMES[health] ?? 'Disconnected'}`}
            title={online ? `${label} connection settings` : 'Connect to execute queries'}
            onClick={event => onOpenSettings(event.currentTarget)}
        >
            {health === ConnectionHealth.CONNECTING
                ? <StatusIndicator status={IndicatorStatus.Running} width="14px" height="14px" />
                : <svg width="14px" height="14px" viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="8" cy="8" r="4" fill={CONNECTION_HEALTH_COLORS[health] ?? CONNECTION_HEALTH_COLORS[ConnectionHealth.NOT_STARTED]} />
                </svg>}
        </IconButton>
    );
};

