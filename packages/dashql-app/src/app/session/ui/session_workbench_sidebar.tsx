import * as React from 'react';
import symbols from '@ankoh/dashql-svg-symbols';
import {
    DndContext,
    type DragEndEvent,
    KeyboardSensor,
    PointerSensor,
    closestCenter,
    useSensor,
    useSensors,
} from '@dnd-kit/core';
import {
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { List, type RowComponentProps, useListRef } from 'react-window';

import * as core from '@ankoh/dashql-core';
import { useComputationDispatch } from '../../../compute/computation_registry.js';
import { DELETE_COMPUTATION } from '../../../compute/computation_state.js';
import { AnchorAlignment, AnchorSide } from '../../../ui/foundations/anchored_position.js';
import { AnchoredOverlay } from '../../../ui/foundations/anchored_overlay.js';
import * as ActionList from '../../../ui/foundations/action_list.js';
import { ButtonSize, ButtonVariant, IconButton } from '../../../ui/foundations/button.js';
import {
    BookIcon,
    AlertIcon,
    ChevronDownIcon,
    ChevronRightIcon,
    CopyIcon,
    DatabaseIcon,
    FileDirectoryIcon,
    LinkIcon,
    PlusIcon,
    SyncIcon,
    TableIcon,
    TrashIcon,
    SymbolIcon,
    UnlinkIcon,
} from '../../../ui/foundations/symbol_icon.js';
import { classNames } from '../../../utils/classnames.js';
import { OPEN_SESSION, SELECT_SESSION, useRouteContext, useRouterNavigate } from '../../router/router.js';
import { SessionSetupStatus } from '../../loading/session_setup_status.js';
import {
    ConnectionState,
    DELETE_CONNECTION,
} from '../../connections/connection_state.js';
import {
    findSessionQueries,
    isListedConnection,
    useConnectionReferences,
    useConnectionRegistry,
    useConnectionAllocator,
    useSessionConnections,
    useDynamicConnectionDispatch,
    type ConnectionReferences,
    type ConnectionRegistry,
    type ResolvedSessionConnections,
    sessionConnectionFromState,
} from '../../connections/connection_registry.js';
import {
    createDefaultHyperWasmConnectionState,
    createConnectionStateFromParams,
    createDefaultConnectionParamsForConnector,
} from '../../connections/connection_params.js';
import { CONNECTOR_INFOS, ConnectorType } from '../../connections/connector_info.js';
import { ConnectionSettingsOverlay } from '../../connections/ui/connection_settings_overlay.js';
import { renderSessionName } from './session_name.js';
import { useCatalogLoaderQueue } from '../../connections/catalog_loader.js';
import { IndicatorStatus, StatusIndicator } from '../../../ui/foundations/status_indicator.js';
import { ConnectionHealth } from '../../connections/connection_state.js';
import { CONNECTION_HEALTH_COLORS, CONNECTION_HEALTH_NAMES } from '../../connections/ui/connection_status.js';
import { SessionConnectionAttentionContext } from './session_connection_attention.js';
import { observeSize } from '../../../ui/foundations/size_observer.js';
import { VerticalScrollShadows } from '../../../ui/foundations/vertical_scroll_shadows.js';
import { displayPath } from '../../storage/session_locator.js';
import { StorageBackendType } from '../../storage/storage_backend.js';
import { SessionStorageOverlay } from '../persistence/ui/session_storage_overlay.js';
import { useStorageReader, useStorageWriter } from '../../storage/storage_provider.js';
import { CompositeStorageBackend } from '../../storage/composite_storage_backend.js';
import { readSessionBundleFromBrowserFolder } from '../persistence/browser_session_folder.js';
import { cloneSession } from '../../storage/session_transfer.js';
import {
    mergeRestoredSessionIntoConnections,
    mergeRestoredSessionIntoScripts,
    restoreSingleSession,
} from '../persistence/app_state_loader.js';
import { useSessionImport } from '../persistence/session_import_provider.js';
import { describeSessionValidationError } from '../../storage/session_validation.js';
import { useInvalidSessionRegistry } from '../persistence/invalid_session_registry.js';
import {
    groupSessionManifestWrites,
    WRITE_SESSION_MANIFEST,
} from '../../storage/storage_writer.js';
import type { SessionScripts } from '../scripts/session_scripts.js';
import {
    useSessionScriptsDeletion,
    useSessionScriptsRegistry,
} from '../scripts/session_scripts_registry.js';
import { useSessionScriptsSetup } from '../scripts/session_scripts_setup.js';
import { BundledSessionsOverlay } from '../../ui/bundled_sessions_overlay.js';
import { connectionLabelParts, connectionLabelText, connectionOrdinals, isHyperWasmConnection, type ConnectionLabelParts } from '../../connections/ui/connection_label.js';
import { ConnectionLabelView, ConnectionProtocolTag } from '../../connections/ui/connection_label_view.js';
import { useAppFlavor } from '../../flavor/flavor_provider.js';
import { canRefreshConnection } from '../../connections/ui/connection_refresh.js';
import { SessionURLShareOverlay } from './session_url_share_overlay.js';
import { SessionFileSaveOverlay } from './session_file_save_overlay.js';
import { isCatalogRefreshRunning } from '../../connections/catalog_update_state.js';
import * as styles from './session_workbench_sidebar.module.css';
import * as actionMenuStyles from './action_menu.module.css';
import { useDashQLCoreSetup } from '../../providers/core_provider.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import { PlatformType, usePlatformType } from '../../../platform/platform_type.js';

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
    type: 'attached-database';
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

interface SessionItem {
    sessionId: string;
    database: ConnectionState;
    /// The connections of the session, the default connection first
    connections: ConnectionState[];
    scripts: SessionScripts;
    label: string;
    path: string;
    isNative: boolean;
}

interface InvalidSessionItem {
    sessionId: string;
    label: string;
    path: string;
    isNative: boolean;
    invalidReason: string;
}

interface Props {
    sessionScripts: SessionScripts;
    closeAfterSelection?: () => void;
    dependencies?: SessionWorkbenchSidebarDependencies;
}

export interface SessionWorkbenchSidebarDependencies {
    useRouterNavigate: typeof useRouterNavigate;
    useRouteContext: typeof useRouteContext;
    useDynamicConnectionDispatch: typeof useDynamicConnectionDispatch;
    useSessionScriptsRegistry: typeof useSessionScriptsRegistry;
    useConnectionRegistry: typeof useConnectionRegistry;
    useConnectionReferences: typeof useConnectionReferences;
    useConnectionAllocator: typeof useConnectionAllocator;
    useSessionScriptsSetup: typeof useSessionScriptsSetup;
    useSessionScriptsDeletion: typeof useSessionScriptsDeletion;
    useComputationDispatch: typeof useComputationDispatch;
    useStorageReader: typeof useStorageReader;
    useStorageWriter: typeof useStorageWriter;
    useDashQLCoreSetup: typeof useDashQLCoreSetup;
    useSessionImport: typeof useSessionImport;
    usePlatformType: typeof usePlatformType;
    useLogger: typeof useLogger;
    useInvalidSessionRegistry: typeof useInvalidSessionRegistry;
    useSessionConnections: typeof useSessionConnections;
    createDefaultHyperWasmConnectionState: typeof createDefaultHyperWasmConnectionState;
    createConnectionStateFromParams: typeof createConnectionStateFromParams;
    BundledSessionsOverlay: typeof BundledSessionsOverlay;
    ConnectionSettingsOverlay: typeof ConnectionSettingsOverlay;
    SessionStorageOverlay: typeof SessionStorageOverlay;
    SessionURLShareOverlay: typeof SessionURLShareOverlay;
    SessionFileSaveOverlay: typeof SessionFileSaveOverlay;
}

const DEFAULT_SESSION_WORKBENCH_SIDEBAR_DEPENDENCIES: SessionWorkbenchSidebarDependencies = {
    useRouterNavigate,
    useRouteContext,
    useDynamicConnectionDispatch,
    useSessionScriptsRegistry,
    useConnectionRegistry,
    useConnectionReferences,
    useConnectionAllocator,
    useSessionScriptsSetup,
    useSessionScriptsDeletion,
    useComputationDispatch,
    useStorageReader,
    useStorageWriter,
    useDashQLCoreSetup,
    useSessionImport,
    usePlatformType,
    useLogger,
    useInvalidSessionRegistry,
    useSessionConnections,
    createDefaultHyperWasmConnectionState,
    createConnectionStateFromParams,
    BundledSessionsOverlay,
    ConnectionSettingsOverlay,
    SessionStorageOverlay,
    SessionURLShareOverlay,
    SessionFileSaveOverlay,
};

const MoreIcon = SymbolIcon('kebab_horizontal');
const ColumnsIcon = SymbolIcon('columns_16');
const SettingsIcon = SymbolIcon('settings_16');
const PencilIcon = SymbolIcon('pencil_16');
const FileZipIcon = SymbolIcon('file_zip_16');

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
        case 'attached-database':
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
    if (row.type === 'attached-database') {
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
}

const connectionKey = (connectionId: string) => `attached-database:${connectionId}`;

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
            next.push({ type: 'attached-database', key: connectionKey(database.connectionId), database });
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
    }), [describeUsage, expanded, labelOf, onDelete, onOpenSettings, rows, toggle]);
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

interface SessionRowMenuProps {
    item: SessionItem;
    onDuplicate: () => void;
    onDelete: () => void;
    dependencies: SessionWorkbenchSidebarDependencies;
}

const SessionRowMenu: React.FC<SessionRowMenuProps> = ({ item, onDuplicate, onDelete, dependencies }) => {
    const [open, setOpen] = React.useState(false);
    const [shareOpen, setShareOpen] = React.useState(false);
    const [exportOpen, setExportOpen] = React.useState(false);
    const archiveExport = useAppFlavor().features.sessionArchiveExport;
    const [storageOpen, setStorageOpen] = React.useState(false);
    const triggerRef = React.useRef<HTMLButtonElement>(null);

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
                    className={styles.session_menu_button}
                    aria-label={`More actions for ${item.label}`}
                    onClick={(event) => {
                        event.stopPropagation();
                        anchorProps.onClick?.(event);
                    }}
                >
                    <MoreIcon size={14} />
                </IconButton>
            )}
        >
            <div className={actionMenuStyles.menu} role="dialog" aria-label={`Actions for ${item.label}`}>
                <ActionList.List aria-label={`Actions for ${item.label}`}>
                    <dependencies.SessionStorageOverlay
                        sessionId={item.sessionId}
                        isOpen={storageOpen}
                        onClose={() => setStorageOpen(false)}
                        side={AnchorSide.OutsideRight}
                        align={AnchorAlignment.Start}
                        renderAnchor={(anchorProps) => (
                            <ActionList.ListItem
                                {...anchorProps}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    setStorageOpen(true);
                                }}
                            >
                                <ActionList.Leading><FileDirectoryIcon size={16} /></ActionList.Leading>
                                <ActionList.ItemText>Storage</ActionList.ItemText>
                            </ActionList.ListItem>
                        )}
                    />
                    <ActionList.ListItem onClick={(event) => {
                        event.stopPropagation();
                        setShareOpen(value => !value);
                    }}>
                        <ActionList.Leading><LinkIcon size={16} /></ActionList.Leading>
                        <ActionList.ItemText>
                            Share as URL
                            <dependencies.SessionURLShareOverlay
                                sessionId={item.sessionId}
                                isOpen={shareOpen}
                                setIsOpen={setShareOpen}
                            />
                        </ActionList.ItemText>
                    </ActionList.ListItem>
                    {/* The list takes elements only, the fragment wraps the optional item */}
                    <>{archiveExport && (
                        <ActionList.ListItem onClick={(event) => {
                            event.stopPropagation();
                            setExportOpen(value => !value);
                        }}>
                            <ActionList.Leading><FileZipIcon size={16} /></ActionList.Leading>
                            <ActionList.ItemText>
                                Export .dashql
                                <dependencies.SessionFileSaveOverlay
                                    isOpen={exportOpen}
                                    setIsOpen={setExportOpen}
                                    conn={item.database}
                                    sessionScripts={item.scripts}
                                    fileName={item.scripts.name ?? item.scripts.sessionMetadata.originalFileName ?? 'session'}
                                />
                            </ActionList.ItemText>
                        </ActionList.ListItem>
                    )}</>
                    <ActionList.ListItem onClick={() => { setOpen(false); onDuplicate(); }}>
                        <ActionList.Leading><CopyIcon size={16} /></ActionList.Leading>
                        <ActionList.ItemText>Duplicate</ActionList.ItemText>
                    </ActionList.ListItem>
                    <ActionList.ListItem className={actionMenuStyles.delete_action} onClick={() => { setOpen(false); onDelete(); }}>
                        <ActionList.Leading>{item.isNative ? <UnlinkIcon size={16} /> : <TrashIcon size={16} />}</ActionList.Leading>
                        <ActionList.ItemText>{item.isNative ? 'Unlink' : 'Delete'}</ActionList.ItemText>
                    </ActionList.ListItem>
                </ActionList.List>
            </div>
        </AnchoredOverlay>
    );
};

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
    /// Open the settings of the connection
    onOpenSettings: (anchor: HTMLButtonElement) => void;
}

/// The health of a connection, opens its settings.
/// Pulses while the current session asks for a connection to execute and the connection is not online.
export const ConnectionStatusButton: React.FC<ConnectionStatusButtonProps> = ({ database, label, usedHere, onOpenSettings }) => {
    const attention = React.useContext(SessionConnectionAttentionContext);
    const health = database.connectionHealth;
    const online = health === ConnectionHealth.ONLINE;
    const pulse = usedHere && !online && attention?.active === true;
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

interface SessionRowProps {
    item: SessionItem;
    selected: boolean;
    labelOf: (database: ConnectionState) => ConnectionLabelParts;
    onOpen: (anchor: HTMLButtonElement) => void;
    onDuplicate: () => void;
    onDelete: () => void;
    dependencies: SessionWorkbenchSidebarDependencies;
}

/// The most connector icons that a session row shows
const MAX_SESSION_CONNECTION_ICONS = 3;

/// The connector icons of the connections of a session
const SessionConnections: React.FC<{ connections: ConnectionState[]; labelOf: (database: ConnectionState) => ConnectionLabelParts }> = ({ connections, labelOf }) => {
    const description = connections
        .map((database, i) => `${connectionLabelText(labelOf(database))}${i === 0 ? ' (default)' : ''}`)
        .join(', ');
    const shown = connections.slice(0, MAX_SESSION_CONNECTION_ICONS);
    const more = connections.length - shown.length;
    return (
        <span className={styles.session_connections} title={description} aria-label={`Connections: ${description}`} role="img">
            {shown.map(database => (
                <svg key={database.connectionId} className={styles.session_connection_icon} width="12" height="12" aria-hidden="true">
                    <use xlinkHref={`${symbols}#${database.connectorInfo.icons.uncolored}`} />
                </svg>
            ))}
            {more > 0 && <span className={styles.session_connections_more} aria-hidden="true">+{more}</span>}
        </span>
    );
};

const SessionRow: React.FC<SessionRowProps> = ({ item, selected, labelOf, onOpen, onDuplicate, onDelete, dependencies }) => {
    const title = item.scripts.name?.trim() || null;
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.sessionId });
    return (
        <li
            ref={setNodeRef}
            className={classNames(
                styles.entry_surface,
                styles.entry_interactive,
                styles.session_row,
                {
                    [styles.entry_selected]: selected,
                    [styles.session_row_dragging]: isDragging,
                },
            )}
            style={{ transform: CSS.Translate.toString(transform), transition }}
            {...attributes}
            {...listeners}
        >
            <button
                type="button"
                className={classNames(styles.session_button, styles.session_button_with_connections)}
                aria-current={selected ? 'page' : undefined}
                title={item.path}
                onClick={event => onOpen(event.currentTarget)}
            >
                <BookIcon size={14} aria-hidden="true" />
                <span className={title ? styles.session_name : styles.session_path}>{title ?? item.path}</span>
                <SessionConnections connections={item.connections} labelOf={labelOf} />
            </button>
            <SessionRowMenu item={item} onDuplicate={onDuplicate} onDelete={onDelete} dependencies={dependencies} />
        </li>
    );
};

const InvalidSessionRow: React.FC<{ item: InvalidSessionItem; onDelete: () => void }> = ({ item, onDelete }) => (
    <li className={classNames(styles.entry_surface, styles.session_row)}>
        <div
            className={classNames(styles.session_button, styles.session_button_invalid)}
            title={item.invalidReason}
        >
            <AlertIcon size={14} aria-hidden="true" />
            <span>
                <span className={styles.session_name}>{item.label}</span>
                <span className={styles.session_error}>{item.invalidReason}</span>
            </span>
        </div>
        <IconButton
            size={ButtonSize.Small}
            variant={ButtonVariant.Invisible}
            className={styles.session_menu_button}
            aria-label={`${item.isNative ? 'Unlink' : 'Delete'} invalid session ${item.label}`}
            onClick={onDelete}
        >
            {item.isNative ? <UnlinkIcon size={14} /> : <TrashIcon size={14} />}
        </IconButton>
    </li>
);

export const SessionWorkbenchSidebar: React.FC<Props> = (props) => {
    const dependencies = props.dependencies ?? DEFAULT_SESSION_WORKBENCH_SIDEBAR_DEPENDENCIES;
    const navigate = dependencies.useRouterNavigate();
    const route = dependencies.useRouteContext();
    const [databaseRegistry, databaseDispatch] = dependencies.useDynamicConnectionDispatch();
    const [scriptsRegistry, setScriptsRegistry] = dependencies.useSessionScriptsRegistry();
    const [, setDatabaseRegistry] = dependencies.useConnectionRegistry();
    const references = dependencies.useConnectionReferences();
    const allocateConnection = dependencies.useConnectionAllocator();
    const setupSessionScripts = dependencies.useSessionScriptsSetup();
    const deleteSessionScripts = dependencies.useSessionScriptsDeletion();
    const computationDispatch = dependencies.useComputationDispatch();
    const storageReader = dependencies.useStorageReader();
    const storageWriter = dependencies.useStorageWriter();
    const setupCore = dependencies.useDashQLCoreSetup();
    const sessionImport = dependencies.useSessionImport();
    const platform = dependencies.usePlatformType();
    const logger = dependencies.useLogger();
    const { invalidSessions, deleteInvalidSession } = dependencies.useInvalidSessionRegistry();
    const attached = dependencies.useSessionConnections(props.sessionScripts.sessionId);
    const sessionConnectionRows = React.useMemo(
        () => attached == null ? [] : connectionDisplayOrder(attached),
        [attached?.main, attached?.attached],
    );
    const [connectionOverlayDatabaseId, setConnectionOverlayDatabaseId] = React.useState<string | null>(null);
    const [connectionOverlayFocusName, setConnectionOverlayFocusName] = React.useState(false);
    const [createOpen, setCreateOpen] = React.useState(false);
    const [createConnectionOpen, setCreateConnectionOpen] = React.useState(false);
    const createConnectionButtonRef = React.useRef<HTMLButtonElement>(null);
    const createButtonRef = React.useRef<HTMLButtonElement>(null);
    const connectionSettingsAnchorRef = React.useRef<HTMLButtonElement>(null);
    const folderButtonRef = React.useRef<HTMLButtonElement>(null);
    const folderInputRef = React.useRef<HTMLInputElement>(null);
    const [sessionOrder, setSessionOrder] = React.useState(() => storageReader.getSessionOrder());
    const reorderWriteRef = React.useRef(Promise.resolve());
    const sessionIds = React.useMemo(
        () => [...scriptsRegistry.sessionScriptsMap.keys()],
        [scriptsRegistry],
    );

    React.useEffect(() => {
        if (route.sessionSetupStatus !== SessionSetupStatus.CONFIGURING
            || route.sessionId !== props.sessionScripts.sessionId) return;
        const connectionId = references.connectionsOf(route.sessionId)[0] ?? null;
        if (connectionId != null) {
            connectionSettingsAnchorRef.current = document.querySelector('[aria-label="Create session"]');
            setConnectionOverlayDatabaseId(connectionId);
        }
    }, [references, scriptsRegistry, props.sessionScripts.sessionId, route.sessionId, route.sessionSetupStatus]);

    const sessions = React.useMemo<SessionItem[]>(() => {
        const rank = new Map(sessionOrder.map((sessionId, index) => [sessionId, index]));
        const items: SessionItem[] = [];
        for (const [sessionId, scripts] of scriptsRegistry.sessionScriptsMap) {
            const [defaultConnectionId, ...otherConnectionIds] = references.connectionsOf(sessionId);
            const database = defaultConnectionId == null ? null : databaseRegistry.connections.get(defaultConnectionId);
            if (database == null) continue;
            const attachedDatabases = otherConnectionIds
                .map(id => databaseRegistry.connections.get(id))
                .filter((connection): connection is ConnectionState => connection != null);
            const location = storageReader.getSessionLocation(sessionId);
            const path = displayPath(sessionId, location);
            items.push({
                sessionId,
                database,
                connections: [database, ...attachedDatabases],
                scripts,
                path,
                label: scripts.name?.trim() || path,
                isNative: location.type === StorageBackendType.Native,
            });
        }
        return items.sort((left, right) => {
            const leftRank = rank.get(left.sessionId) ?? Number.MAX_SAFE_INTEGER;
            const rightRank = rank.get(right.sessionId) ?? Number.MAX_SAFE_INTEGER;
            return leftRank - rightRank;
        });
    }, [databaseRegistry, references, scriptsRegistry, storageReader, sessionOrder]);

    React.useEffect(() => {
        const ids = sessionIds;
        setSessionOrder(current => {
            const next = current.filter(id => ids.includes(id));
            for (const id of ids) if (!next.includes(id)) next.push(id);
            return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
        });
    }, [sessionIds]);

    const invalidItems = React.useMemo<InvalidSessionItem[]>(() => [...invalidSessions.values()].map(invalid => {
        const location = storageReader.getSessionLocation(invalid.sessionId);
        return {
            sessionId: invalid.sessionId,
            label: invalid.title,
            path: displayPath(invalid.sessionId, location),
            isNative: location.type === StorageBackendType.Native,
            invalidReason: describeSessionValidationError(invalid.error),
        };
    }), [invalidSessions, storageReader]);
    const sessionCount = sessions.length + invalidItems.length;
    // The references follow the scripts registry
    const connectionRows = React.useMemo(
        () => listedConnections(databaseRegistry, references, sessionConnectionRows),
        [databaseRegistry, references, scriptsRegistry, sessionConnectionRows],
    );
    const sessionConnectionIds = React.useMemo(
        () => new Set(sessionConnectionRows.map(database => database.connectionId)),
        [sessionConnectionRows],
    );
    const ordinals = React.useMemo(
        () => connectionOrdinals(databaseRegistry, references),
        [databaseRegistry, references, scriptsRegistry],
    );
    const labelOf = React.useCallback(
        (database: ConnectionState) => connectionLabelParts(database, ordinals.get(database.connectionId) ?? null),
        [ordinals],
    );
    const connectionCount = connectionRows.length;
    const describeUsage = React.useCallback((connectionId: string): ConnectionUsage => ({
        sessionCount: references.sessionsOf(connectionId).length,
        usedHere: sessionConnectionRows.some(database => database.connectionId === connectionId),
    }), [sessionConnectionRows, references, scriptsRegistry]);
    const initiallyExpanded = React.useCallback((database: ConnectionState, _count: number) => (
        sessionConnectionRows.includes(database)
        && isConnectionInitiallyExpanded(database, sessionConnectionRows.length)
    ), [sessionConnectionRows]);

    const dndSensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );
    const reorderSessions = React.useCallback((event: DragEndEvent) => {
        if (event.over == null || event.active.id === event.over.id) return;
        setSessionOrder(current => {
            const from = current.indexOf(String(event.active.id));
            const to = current.indexOf(String(event.over!.id));
            if (from < 0 || to < 0) return current;
            const next = [...current];
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved);
            if ('reorderSessions' in storageReader.backend) {
                reorderWriteRef.current = reorderWriteRef.current
                    .catch(() => {})
                    .then(() => (storageReader.backend as CompositeStorageBackend).reorderSessions(next))
                    .catch(error => logger.warn('failed to persist session order', { error: String(error) }, 'session_workbench'));
            }
            return next;
        });
    }, [logger, storageReader.backend]);

    /// Create a session that uses an existing connection
    const createSessionWithConnection = React.useCallback((database: ConnectionState) => {
        setCreateOpen(false);
        const sessionId = crypto.randomUUID();
        setupSessionScripts(sessionId, database);
        void storageWriter.write(
            groupSessionManifestWrites(sessionId),
            { type: WRITE_SESSION_MANIFEST, value: [sessionId, database.connectionId, [sessionConnectionFromState(database)]] },
        );
        navigate({ type: SELECT_SESSION, value: sessionId });
        props.closeAfterSelection?.();
    }, [navigate, props.closeAfterSelection, setupSessionScripts, storageWriter]);

    /// Create a connection that no session uses yet and open its settings
    const createConnection = React.useCallback((connector: ConnectorType) => {
        setCreateConnectionOpen(false);
        const params = createDefaultConnectionParamsForConnector(CONNECTOR_INFOS[connector]);
        const initialDatabase = dependencies.createConnectionStateFromParams(props.sessionScripts.instance, params);
        const database = allocateConnection({ ...initialDatabase, active: true });
        connectionSettingsAnchorRef.current = createConnectionButtonRef.current;
        setConnectionOverlayDatabaseId(database.connectionId);
    }, [allocateConnection, dependencies, props.sessionScripts.instance]);

    /// Delete a connection that no session uses
    const deleteConnection = React.useCallback((connectionId: string) => {
        const database = databaseRegistry.connections.get(connectionId);
        if (database == null || references.sessionsOf(connectionId).length > 0) return;
        if (!window.confirm(`Delete the connection "${connectionLabelText(labelOf(database))}"?`)) return;
        databaseDispatch(connectionId, { type: DELETE_CONNECTION, value: null });
    }, [databaseDispatch, databaseRegistry, labelOf, references]);

    const createSession = React.useCallback((connector: ConnectorType) => {
        setCreateOpen(false);
        const sessionId = crypto.randomUUID();
        const params = createDefaultConnectionParamsForConnector(CONNECTOR_INFOS[connector]);
        const initialDatabase = connector === ConnectorType.HYPER
            ? dependencies.createDefaultHyperWasmConnectionState(props.sessionScripts.instance)
            : dependencies.createConnectionStateFromParams(props.sessionScripts.instance, params);
        // The session is committed now; settings must not switch its initialized script dialect.
        const database = allocateConnection({ ...initialDatabase, active: true });
        setupSessionScripts(sessionId, database);
        void storageWriter.write(
            groupSessionManifestWrites(sessionId),
            { type: WRITE_SESSION_MANIFEST, value: [sessionId, database.connectionId, [sessionConnectionFromState(database)]] },
        );
        navigate({ type: SELECT_SESSION, value: sessionId });
        props.closeAfterSelection?.();
    }, [allocateConnection, dependencies, navigate, props.closeAfterSelection, props.sessionScripts.instance, setupSessionScripts, storageWriter]);

    const closeConnectionOverlay = React.useCallback(() => {
        setConnectionOverlayDatabaseId(null);
        setConnectionOverlayFocusName(false);
        if (route.sessionSetupStatus === SessionSetupStatus.CONFIGURING && route.sessionId != null) {
            navigate({ type: SELECT_SESSION, value: route.sessionId });
        }
    }, [navigate, route.sessionId, route.sessionSetupStatus]);

    const duplicateSession = React.useCallback(async (item: SessionItem) => {
        const newSessionId = crypto.randomUUID();
        try {
            const coreInstance = await setupCore('session_duplicate');
            await cloneSession(item.sessionId, storageReader.backend, storageWriter.backend, newSessionId, logger);
            const restored = await restoreSingleSession(
                coreInstance,
                storageWriter.backend,
                logger,
                newSessionId,
                databaseRegistry,
            );
            setDatabaseRegistry(registry => mergeRestoredSessionIntoConnections(registry, restored));
            setScriptsRegistry(registry => mergeRestoredSessionIntoScripts(registry, restored));
        } catch (error) {
            logger.warn('failed to duplicate session', {
                sessionId: item.sessionId,
                error: String(error),
            }, 'session_workbench');
        }
    }, [databaseRegistry, logger, setDatabaseRegistry, setScriptsRegistry, setupCore, storageReader.backend, storageWriter.backend]);

    const openSessionFolder = React.useCallback(async () => {
        if (!(storageReader.backend instanceof CompositeStorageBackend)) return;
        if (platform === PlatformType.WEB) {
            folderInputRef.current?.click();
            return;
        }
        const folder = await globalThis.dashqlElectron?.openDirectory('Open an existing session folder');
        if (folder == null) return;
        try {
            await sessionImport.importNativeFolder(folder, {
                mode: 'anchored',
                anchorRef: folderButtonRef,
                returnFocusRef: folderButtonRef,
            });
        } catch (error) {
            logger.error('adding native session from folder failed', { error: String(error) }, 'session_workbench');
        }
    }, [logger, sessionImport, platform, storageReader.backend]);

    const openBrowserSessionFolder = React.useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const input = event.currentTarget;
        if (input.files == null || input.files.length === 0) return;
        try {
            const bundle = await readSessionBundleFromBrowserFolder(input.files);
            await sessionImport.importPortableBundle(bundle, {
                presentation: {
                    mode: 'anchored',
                    anchorRef: folderButtonRef,
                    returnFocusRef: folderButtonRef,
                },
            });
        } catch (error) {
            logger.error('adding browser session folder failed', { error: String(error) }, 'session_workbench');
        } finally {
            input.value = '';
        }
    }, [logger, sessionImport]);

    const deleteSession = React.useCallback(async (item: SessionItem) => {
        const action = item.isNative ? 'Unlink' : 'Delete';
        if (!window.confirm(`${action} "${item.label}"?${item.isNative ? ' The folder and its files will remain on disk.' : ''}`)) return;
        try {
            await storageWriter.backend.deleteSession(item.sessionId);
        } catch (error) {
            console.error('Failed to delete session from storage:', error);
            return;
        }
        deleteSessionScripts(item.sessionId);
        // Connections outlive the sessions that reference them, only the session's own
        // computations are dropped.
        for (const database of item.connections) {
            for (const queryId of findSessionQueries(database, item.sessionId)) {
                computationDispatch({ type: DELETE_COMPUTATION, value: [queryId] });
            }
        }

        if (item.sessionId === props.sessionScripts.sessionId) {
            const next = sessions.find(session => session.sessionId !== item.sessionId);
            if (next != null) navigate({ type: OPEN_SESSION, value: next.sessionId });
        }
    }, [computationDispatch, deleteSessionScripts, navigate, sessions, props.sessionScripts.sessionId, storageWriter.backend]);

    const openSession = React.useCallback((item: SessionItem) => {
        navigate({ type: SELECT_SESSION, value: item.sessionId });
        props.closeAfterSelection?.();
    }, [navigate, props.closeAfterSelection]);
    const sessionListRef = React.useRef<HTMLUListElement>(null);
    const getSessionScrollElement = React.useCallback(() => sessionListRef.current, []);

    return (
        <nav className={styles.workbench} aria-label="Session workbench" data-electron-drag-region>
            <section className={styles.section} aria-labelledby="workbench-sessions-heading">
                <header className={styles.section_header}>
                    <div className={styles.section_title}>
                        <h2 id="workbench-sessions-heading" className={styles.section_heading}>Sessions</h2>
                        <span
                            className={styles.section_count}
                            aria-label={`${sessionCount} ${sessionCount === 1 ? 'session' : 'sessions'}`}
                        >
                            {sessionCount}
                        </span>
                    </div>
                    <div className={styles.section_actions}>
                        <dependencies.BundledSessionsOverlay
                            side={AnchorSide.OutsideBottom}
                            align={AnchorAlignment.End}
                            triggerSize={ButtonSize.Small}
                            triggerIconSize={14}
                        />
                        {storageReader.backend instanceof CompositeStorageBackend && (
                            <>
                                <IconButton
                                    ref={folderButtonRef}
                                    size={ButtonSize.Small}
                                    variant={ButtonVariant.Invisible}
                                    aria-label="Open session folder"
                                    onClick={openSessionFolder}
                                >
                                    <FileDirectoryIcon size={14} />
                                </IconButton>
                                {platform === PlatformType.WEB && (
                                    <input
                                        ref={folderInputRef}
                                        className={styles.folder_input}
                                        type="file"
                                        multiple
                                        {...({ webkitdirectory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
                                        tabIndex={-1}
                                        aria-hidden="true"
                                        onChange={openBrowserSessionFolder}
                                    />
                                )}
                            </>
                        )}
                        <AnchoredOverlay
                            open={createOpen}
                            onOpen={() => setCreateOpen(true)}
                            onClose={() => setCreateOpen(false)}
                            anchorRef={createButtonRef}
                            returnFocusRef={createButtonRef}
                            side={AnchorSide.OutsideBottom}
                            align={AnchorAlignment.End}
                            renderAnchor={anchorProps => <IconButton
                                {...anchorProps}
                                ref={createButtonRef}
                                size={ButtonSize.Small}
                                variant={ButtonVariant.Invisible}
                                aria-label="Create session"
                            ><PlusIcon size={14} /></IconButton>}
                        >
                            <div className={actionMenuStyles.menu} role="dialog" aria-label="Choose session connector">
                                <ActionList.List aria-label="Session connector">
                                    {/* The list takes elements only, the fragment wraps the optional group */}
                                    <>{connectionRows.length > 0 && (
                                        <>
                                            <ActionList.GroupHeading>Existing connection</ActionList.GroupHeading>
                                            {connectionRows.map(database => (
                                                <ActionList.ListItem key={database.connectionId} onClick={() => createSessionWithConnection(database)}>
                                                    <ActionList.Leading>
                                                        <svg width="16px" height="16px" aria-hidden="true">
                                                            <use xlinkHref={`${symbols}#${database.connectorInfo.icons.colored}`} />
                                                        </svg>
                                                    </ActionList.Leading>
                                                    <ActionList.ItemText>{labelOf(database).name}</ActionList.ItemText>
                                                    <ActionList.Trailing><ConnectionProtocolTag detail={labelOf(database).detail} /></ActionList.Trailing>
                                                </ActionList.ListItem>
                                            ))}
                                            <ActionList.GroupHeading>New connection</ActionList.GroupHeading>
                                        </>
                                    )}</>
                                    <>{([ConnectorType.HYPER, ConnectorType.TRINO, ConnectorType.SALESFORCE_DATA_CLOUD] as const).map(connector => (
                                        <ActionList.ListItem key={connector} onClick={() => createSession(connector)}>
                                            <ActionList.Leading>
                                                <svg width="16px" height="16px" aria-hidden="true">
                                                    <use xlinkHref={`${symbols}#${CONNECTOR_INFOS[connector].icons.colored}`} />
                                                </svg>
                                            </ActionList.Leading>
                                            <ActionList.ItemText>{CONNECTOR_INFOS[connector].names.displayShort}</ActionList.ItemText>
                                        </ActionList.ListItem>
                                    ))}</>
                                </ActionList.List>
                            </div>
                        </AnchoredOverlay>
                    </div>
                </header>
                <div className={styles.scroll_shadow_container}>
                    <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={reorderSessions}>
                        <SortableContext items={sessions.map(item => item.sessionId)} strategy={verticalListSortingStrategy}>
                            <ul ref={sessionListRef} className={styles.session_list} aria-label="Sessions" data-electron-drag-region="false">
                                {sessions.map(item => (
                                    <SessionRow
                                        key={item.sessionId}
                                        item={item}
                                        selected={item.sessionId === props.sessionScripts.sessionId}
                                        labelOf={labelOf}
                                        onOpen={() => openSession(item)}
                                        onDuplicate={() => { void duplicateSession(item); }}
                                        onDelete={() => { void deleteSession(item); }}
                                        dependencies={dependencies}
                                    />
                                ))}
                                {invalidItems.map(item => (
                                    <InvalidSessionRow
                                        key={item.sessionId}
                                        item={item}
                                        onDelete={() => { void deleteInvalidSession(item.sessionId); }}
                                    />
                                ))}
                            </ul>
                        </SortableContext>
                    </DndContext>
                    <VerticalScrollShadows
                        getScrollElement={getSessionScrollElement}
                        refreshKey={`${sessions.length}:${invalidItems.length}`}
                    />
                </div>
            </section>

            <section className={classNames(styles.section, styles.database_section)} aria-labelledby="workbench-databases-heading">
                <header className={styles.section_header}>
                    <div className={styles.section_title}>
                        <h2 id="workbench-databases-heading" className={styles.section_heading}>Connections</h2>
                        <span
                            className={styles.section_count}
                            aria-label={`${connectionCount} ${connectionCount === 1 ? 'connection' : 'connections'}`}
                        >
                            {connectionCount}
                        </span>
                    </div>
                    <AnchoredOverlay
                        open={createConnectionOpen}
                        onOpen={() => setCreateConnectionOpen(true)}
                        onClose={() => setCreateConnectionOpen(false)}
                        anchorRef={createConnectionButtonRef}
                        returnFocusRef={createConnectionButtonRef}
                        side={AnchorSide.OutsideBottom}
                        align={AnchorAlignment.End}
                        renderAnchor={anchorProps => <IconButton
                            {...anchorProps}
                            ref={createConnectionButtonRef}
                            size={ButtonSize.Small}
                            variant={ButtonVariant.Invisible}
                            aria-label="Create connection"
                        ><PlusIcon size={14} /></IconButton>}
                    >
                        <div className={actionMenuStyles.menu} role="dialog" aria-label="Choose connection connector">
                            <ActionList.List aria-label="Connection connector">
                                {([ConnectorType.HYPER, ConnectorType.TRINO, ConnectorType.SALESFORCE_DATA_CLOUD] as const).map(connector => (
                                    <ActionList.ListItem key={connector} onClick={() => createConnection(connector)}>
                                        <ActionList.Leading>
                                            <svg width="16px" height="16px" aria-hidden="true">
                                                <use xlinkHref={`${symbols}#${CONNECTOR_INFOS[connector].icons.colored}`} />
                                            </svg>
                                        </ActionList.Leading>
                                        <ActionList.ItemText>{CONNECTOR_INFOS[connector].names.displayShort}</ActionList.ItemText>
                                    </ActionList.ListItem>
                                ))}
                            </ActionList.List>
                        </div>
                    </AnchoredOverlay>
                </header>
                <div className={styles.database_body} data-electron-drag-region="false">
                    {connectionRows.length > 0 && <ConnectionTree
                        databases={connectionRows}
                        describeUsage={describeUsage}
                        onDelete={deleteConnection}
                        initiallyExpanded={initiallyExpanded}
                        sessionConnectionIds={sessionConnectionIds}
                        labelOf={labelOf}
                        onOpenSettings={(connectionId, anchor, focusName) => {
                            connectionSettingsAnchorRef.current = anchor;
                            setConnectionOverlayFocusName(focusName ?? false);
                            setConnectionOverlayDatabaseId(connectionId);
                        }}
                    />}
                </div>
            </section>
            <dependencies.ConnectionSettingsOverlay
                connectionId={connectionOverlayDatabaseId}
                isOpen={connectionOverlayDatabaseId != null}
                onClose={closeConnectionOverlay}
                anchorRef={connectionSettingsAnchorRef}
                renderSessionName={renderSessionName}
                focusName={connectionOverlayFocusName}
            />
        </nav>
    );
};
