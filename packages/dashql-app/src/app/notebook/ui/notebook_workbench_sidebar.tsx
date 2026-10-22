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
import { OPEN_NOTEBOOK, SELECT_NOTEBOOK, useRouteContext, useRouterNavigate } from '../../router/router.js';
import { NotebookSetupStatus } from '../../router/notebook_setup_status.js';
import {
    AttachedDatabaseState,
    DELETE_ATTACHED_DATABASE,
} from '../connections/attached_database_state.js';
import {
    resolveNotebookAttachedDatabases,
    useAttachedDatabaseRegistry,
    useNotebookAttachedDatabases,
    useAttachedDatabaseStateAllocator,
    useDynamicAttachedDatabaseDispatch,
} from '../connections/attached_database_registry.js';
import {
    createDefaultHyperWasmAttachedDatabaseState,
    createConnectionStateFromParams,
    createDefaultConnectionParamsForConnector,
} from '../connections/connection_params.js';
import { CONNECTOR_INFOS, ConnectorType } from '../connections/connector_info.js';
import { ConnectionSettingsOverlay } from '../connections/ui/connection_settings_overlay.js';
import { useCatalogLoaderQueue } from '../connections/catalog_loader.js';
import { IndicatorStatus, StatusIndicator } from '../../../ui/foundations/status_indicator.js';
import { observeSize } from '../../../ui/foundations/size_observer.js';
import { VerticalScrollShadows } from '../../../ui/foundations/vertical_scroll_shadows.js';
import { displayPath } from '../persistence/notebook_locator.js';
import { StorageBackendType } from '../persistence/storage_backend.js';
import { NotebookStorageOverlay } from '../persistence/ui/notebook_storage_overlay.js';
import { useStorageReader, useStorageWriter } from '../persistence/storage_provider.js';
import { CompositeStorageBackend } from '../persistence/composite_storage_backend.js';
import { readNotebookBundleFromBrowserFolder } from '../persistence/browser_notebook_folder.js';
import { cloneNotebook } from '../persistence/storage_migration.js';
import {
    mergeRestoredNotebookIntoConnections,
    mergeRestoredNotebookIntoScripts,
    restoreSingleNotebook,
} from '../persistence/app_state_loader.js';
import { useNotebookImport } from '../persistence/notebook_import_provider.js';
import { describeNotebookValidationError } from '../persistence/notebook_validation.js';
import { useInvalidNotebookRegistry } from '../persistence/invalid_notebook_registry.js';
import {
    groupNotebookManifestWrites,
    WRITE_NOTEBOOK_MANIFEST,
} from '../persistence/storage_writer.js';
import type { NotebookScripts } from '../scripts/notebook_scripts.js';
import {
    useNotebookScriptsDeletion,
    useNotebookScriptsRegistry,
} from '../scripts/notebook_scripts_registry.js';
import { useNotebookScriptsSetup } from '../scripts/notebook_scripts_setup.js';
import { BundledNotebooksOverlay } from '../../ui/bundled_notebooks_overlay.js';
import { attachedDatabaseLabel, isHyperWasmAttachedDatabase } from './attached_database_label.js';
import { useAppFlavor } from '../../flavor/flavor_provider.js';
import { canRefreshAttachedDatabase } from './attached_database_refresh.js';
import { NotebookURLShareOverlay } from './notebook_url_share_overlay.js';
import { NotebookFileSaveOverlay } from './notebook_file_save_overlay.js';
import { isCatalogRefreshRunning } from '../connections/catalog_update_state.js';
import * as styles from './notebook_workbench_sidebar.module.css';
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

interface AttachedDatabaseListRow {
    type: 'attached-database';
    key: string;
    database: AttachedDatabaseState;
}

type AttachedDatabaseTreeRow = AttachedDatabaseListRow | CatalogRow;

const ATTACHED_DATABASE_ROW_HEIGHT = 38;
const CATALOG_ROW_HEIGHT = 34;

export function isVisibleCatalogNode(kind: CatalogNode['kind'], name: string): boolean {
    return (kind !== 'database' && kind !== 'schema') || name.trim().length > 0;
}

interface NotebookItem {
    notebookId: string;
    database: AttachedDatabaseState;
    scripts: NotebookScripts;
    label: string;
    path: string;
    isNative: boolean;
}

interface InvalidNotebookItem {
    notebookId: string;
    label: string;
    path: string;
    isNative: boolean;
    invalidReason: string;
}

interface Props {
    notebookScripts: NotebookScripts;
    closeAfterSelection?: () => void;
    dependencies?: NotebookWorkbenchSidebarDependencies;
}

export interface NotebookWorkbenchSidebarDependencies {
    useRouterNavigate: typeof useRouterNavigate;
    useRouteContext: typeof useRouteContext;
    useDynamicAttachedDatabaseDispatch: typeof useDynamicAttachedDatabaseDispatch;
    useNotebookScriptsRegistry: typeof useNotebookScriptsRegistry;
    useAttachedDatabaseRegistry: typeof useAttachedDatabaseRegistry;
    useAttachedDatabaseStateAllocator: typeof useAttachedDatabaseStateAllocator;
    useNotebookScriptsSetup: typeof useNotebookScriptsSetup;
    useNotebookScriptsDeletion: typeof useNotebookScriptsDeletion;
    useComputationDispatch: typeof useComputationDispatch;
    useStorageReader: typeof useStorageReader;
    useStorageWriter: typeof useStorageWriter;
    useDashQLCoreSetup: typeof useDashQLCoreSetup;
    useNotebookImport: typeof useNotebookImport;
    usePlatformType: typeof usePlatformType;
    useLogger: typeof useLogger;
    useInvalidNotebookRegistry: typeof useInvalidNotebookRegistry;
    useNotebookAttachedDatabases: typeof useNotebookAttachedDatabases;
    createDefaultHyperWasmAttachedDatabaseState: typeof createDefaultHyperWasmAttachedDatabaseState;
    createConnectionStateFromParams: typeof createConnectionStateFromParams;
    BundledNotebooksOverlay: typeof BundledNotebooksOverlay;
    ConnectionSettingsOverlay: typeof ConnectionSettingsOverlay;
    NotebookStorageOverlay: typeof NotebookStorageOverlay;
    NotebookURLShareOverlay: typeof NotebookURLShareOverlay;
    NotebookFileSaveOverlay: typeof NotebookFileSaveOverlay;
}

const DEFAULT_NOTEBOOK_WORKBENCH_SIDEBAR_DEPENDENCIES: NotebookWorkbenchSidebarDependencies = {
    useRouterNavigate,
    useRouteContext,
    useDynamicAttachedDatabaseDispatch,
    useNotebookScriptsRegistry,
    useAttachedDatabaseRegistry,
    useAttachedDatabaseStateAllocator,
    useNotebookScriptsSetup,
    useNotebookScriptsDeletion,
    useComputationDispatch,
    useStorageReader,
    useStorageWriter,
    useDashQLCoreSetup,
    useNotebookImport,
    usePlatformType,
    useLogger,
    useInvalidNotebookRegistry,
    useNotebookAttachedDatabases,
    createDefaultHyperWasmAttachedDatabaseState,
    createConnectionStateFromParams,
    BundledNotebooksOverlay,
    ConnectionSettingsOverlay,
    NotebookStorageOverlay,
    NotebookURLShareOverlay,
    NotebookFileSaveOverlay,
};

const MoreIcon = SymbolIcon('kebab_horizontal');
const ColumnsIcon = SymbolIcon('columns_16');
const SettingsIcon = SymbolIcon('settings_16');
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

interface AttachedDatabaseTreeEntryProps {
    name: string;
    icon: React.ReactNode;
    depth: number;
    expanded?: boolean;
    onToggle?: () => void;
    children?: React.ReactNode;
    className?: string;
}

const AttachedDatabaseTreeEntry: React.FC<AttachedDatabaseTreeEntryProps> = ({
    name,
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
                    <span className={styles.tree_entry_name}>{name}</span>
                </button>
            ) : (
                <div className={styles.tree_entry_main}>
                    <span className={styles.tree_entry_spacer} />
                    <span className={styles.tree_entry_icon} aria-hidden="true">{icon}</span>
                    <span className={styles.tree_entry_name}>{name}</span>
                </div>
            )}
            {children != null && <span className={styles.tree_entry_children}>{children}</span>}
        </div>
    );
};

interface AttachedDatabaseTreeRowProps {
    rows: AttachedDatabaseTreeRow[];
    expanded: ReadonlySet<string>;
    onToggle: (key: string) => void;
    onOpenSettings: (databaseId: string, anchor: HTMLButtonElement) => void;
}

export function attachedDatabaseTreeRowHeight(index: number, props: AttachedDatabaseTreeRowProps): number {
    return props.rows[index]?.type === 'attached-database'
        ? ATTACHED_DATABASE_ROW_HEIGHT + (index === 0 ? 8 : 0)
        : CATALOG_ROW_HEIGHT;
}

const AttachedDatabaseTreeRow = (props: RowComponentProps<AttachedDatabaseTreeRowProps>) => {
    const row = props.rows[props.index];
    if (row == null) return <div style={props.style} />;
    if (row.type === 'attached-database') {
        const expanded = props.expanded.has(row.key);
        const label = attachedDatabaseLabel(row.database);
        return (
            <div
                style={props.style}
                className={classNames(
                    styles.tree_row_container,
                    styles.database_row_container,
                    props.index === 0 && styles.database_row_container_first,
                )}
            >
                <AttachedDatabaseTreeEntry
                    className={styles.database_row}
                    name={label}
                    depth={0}
                    expanded={expanded}
                    onToggle={() => props.onToggle(row.key)}
                    icon={(
                        <svg width="14" height="14">
                            <use xlinkHref={`${symbols}#${row.database.connectorInfo.icons.colored}`} />
                        </svg>
                    )}
                >
                    <AttachedDatabaseRefreshButton database={row.database} label={label} />
                    <AttachedDatabaseRowMenu
                        database={row.database}
                        label={label}
                        onOpenSettings={anchor => props.onOpenSettings(row.database.databaseId, anchor)}
                    />
                </AttachedDatabaseTreeEntry>
            </div>
        );
    }
    const node = row;
    const expandable = node.childCount > 0;
    const expanded = props.expanded.has(node.key);
    return (
        <div style={props.style} className={styles.tree_row_container}>
            <AttachedDatabaseTreeEntry
                className={styles.catalog_row}
                name={node.name || 'Unnamed'}
                icon={catalogIcon(node.kind)}
                depth={node.depth + 1}
                expanded={expanded}
                onToggle={expandable ? () => props.onToggle(node.key) : undefined}
            >
                <span className={styles.catalog_node_kind}>{node.kind}</span>
            </AttachedDatabaseTreeEntry>
        </div>
    );
};

interface AttachedDatabaseTreeProps {
    databases: AttachedDatabaseState[];
    onOpenSettings: (databaseId: string, anchor: HTMLButtonElement) => void;
}

const attachedDatabaseKey = (databaseId: string) => `attached-database:${databaseId}`;

/// Keep the identity of an array as long as its elements are identical
function useShallowStableArray<T>(values: T[]): T[] {
    const ref = React.useRef(values);
    if (ref.current.length !== values.length || ref.current.some((value, i) => value !== values[i])) {
        ref.current = values;
    }
    return ref.current;
}

export const AttachedDatabaseTree: React.FC<AttachedDatabaseTreeProps> = ({ databases, onOpenSettings }) => {
    // The database states change with every query event while the catalogs rarely change.
    // A catalog caches its snapshot until it is modified (which destroys the snapshot), so the snapshot identity
    // tells us when the trees must be rebuilt. Never keep a reader of a snapshot that is no longer current.
    const databaseIds = useShallowStableArray(databases.map(database => database.databaseId));
    const snapshots = useShallowStableArray(databases.map(database => database.catalog.createSnapshot()));
    const catalogTrees = React.useMemo(() => databaseIds.map((databaseId, i) => {
        const reader = snapshots[i].read();
        return {
            databaseId,
            reader,
            roots: createCatalogTree(reader, `${attachedDatabaseKey(databaseId)}/catalog`),
        };
    }), [databaseIds, snapshots]);
    const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => {
        const initial = new Set<string>();
        catalogTrees.forEach((tree, i) => {
            if (!isAttachedDatabaseInitiallyExpanded(databases[i], databases.length)) return;
            initial.add(attachedDatabaseKey(tree.databaseId));
            for (const root of tree.roots) initial.add(root.key);
        });
        return initial;
    });
    const knownDatabaseIds = React.useRef(new Set(databaseIds));
    React.useEffect(() => {
        const nextDatabaseIds = new Set(databaseIds);
        setExpanded(current => {
            const next = new Set([...current].filter(key => {
                const databaseId = key.split(':', 2)[1]?.split('/', 1)[0];
                return databaseId == null || nextDatabaseIds.has(databaseId);
            }));
            catalogTrees.forEach((tree, i) => {
                if (knownDatabaseIds.current.has(tree.databaseId)) return;
                if (isAttachedDatabaseInitiallyExpanded(databases[i], databases.length)) {
                    next.add(attachedDatabaseKey(tree.databaseId));
                    for (const root of tree.roots) next.add(root.key);
                }
            });
            return next;
        });
        knownDatabaseIds.current = nextDatabaseIds;
    }, [databaseIds]);
    const catalogRows = React.useMemo(() => catalogTrees.map(tree => (
        expanded.has(attachedDatabaseKey(tree.databaseId))
            ? flattenCatalogRows(tree.reader, tree.roots, expanded)
            : []
    )), [catalogTrees, expanded]);
    const rows = React.useMemo(() => {
        const next: AttachedDatabaseTreeRow[] = [];
        databases.forEach((database, i) => {
            next.push({ type: 'attached-database', key: attachedDatabaseKey(database.databaseId), database });
            next.push(...catalogRows[i]);
        });
        return next;
    }, [databases, catalogRows]);
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
    const rowProps = React.useMemo<AttachedDatabaseTreeRowProps>(() => ({
        rows,
        expanded,
        onToggle: toggle,
        onOpenSettings,
    }), [expanded, onOpenSettings, rows, toggle]);
    return (
        <div ref={containerRef} className={styles.database_list} aria-label="Attached databases and catalogs">
            <List
                listRef={listRef}
                style={{ width: size?.width ?? 200, height: size?.height ?? 200 }}
                rowCount={rows.length}
                rowHeight={attachedDatabaseTreeRowHeight}
                rowComponent={AttachedDatabaseTreeRow}
                rowProps={rowProps}
            />
            <VerticalScrollShadows getScrollElement={getScrollElement} refreshKey={rows.length} />
        </div>
    );
};

export function attachedDatabaseDisplayOrder(attached: NonNullable<ReturnType<typeof resolveNotebookAttachedDatabases>>): AttachedDatabaseState[] {
    return [attached.main, ...attached.attached];
}

export function isAttachedDatabaseInitiallyExpanded(database: AttachedDatabaseState, databaseCount: number): boolean {
    return databaseCount === 1 || !isHyperWasmAttachedDatabase(database);
}

interface NotebookRowMenuProps {
    item: NotebookItem;
    onDuplicate: () => void;
    onDelete: () => void;
    dependencies: NotebookWorkbenchSidebarDependencies;
}

const NotebookRowMenu: React.FC<NotebookRowMenuProps> = ({ item, onDuplicate, onDelete, dependencies }) => {
    const [open, setOpen] = React.useState(false);
    const [shareOpen, setShareOpen] = React.useState(false);
    const [exportOpen, setExportOpen] = React.useState(false);
    const archiveExport = useAppFlavor().features.notebookArchiveExport;
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
                    className={styles.notebook_menu_button}
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
                    <dependencies.NotebookStorageOverlay
                        notebookId={item.notebookId}
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
                            <dependencies.NotebookURLShareOverlay
                                notebookId={item.notebookId}
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
                                <dependencies.NotebookFileSaveOverlay
                                    isOpen={exportOpen}
                                    setIsOpen={setExportOpen}
                                    conn={item.database}
                                    notebookScripts={item.scripts}
                                    fileName={item.scripts.name ?? item.scripts.notebookMetadata.originalFileName ?? 'notebook'}
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

interface AttachedDatabaseRowMenuProps {
    database: AttachedDatabaseState;
    label: string;
    onOpenSettings: (anchor: HTMLButtonElement) => void;
    dependencies?: AttachedDatabaseRefreshDependencies;
}

export interface AttachedDatabaseRefreshDependencies {
    useCatalogLoaderQueue: typeof useCatalogLoaderQueue;
}

const DEFAULT_ATTACHED_DATABASE_REFRESH_DEPENDENCIES: AttachedDatabaseRefreshDependencies = {
    useCatalogLoaderQueue,
};

export const AttachedDatabaseRowMenu: React.FC<AttachedDatabaseRowMenuProps> = ({ database, label, onOpenSettings, dependencies = DEFAULT_ATTACHED_DATABASE_REFRESH_DEPENDENCIES }) => {
    const [open, setOpen] = React.useState(false);
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const refreshCatalog = dependencies.useCatalogLoaderQueue();
    const isRefreshing = isCatalogRefreshRunning(database);
    const canRefresh = canRefreshAttachedDatabase(database);

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
                    <ActionList.ListItem
                        disabled={!canRefresh}
                        aria-busy={isRefreshing}
                        onClick={() => {
                            setOpen(false);
                            refreshCatalog(database.databaseId, true);
                        }}
                    >
                        <ActionList.Leading>
                            {isRefreshing
                                ? <StatusIndicator status={IndicatorStatus.Running} width="16px" height="16px" />
                                : <SyncIcon size={16} />}
                        </ActionList.Leading>
                        <ActionList.ItemText>Refresh</ActionList.ItemText>
                    </ActionList.ListItem>
                </ActionList.List>
            </div>
        </AnchoredOverlay>
    );
};

interface AttachedDatabaseRefreshButtonProps {
    database: AttachedDatabaseState;
    label: string;
    dependencies?: AttachedDatabaseRefreshDependencies;
}

export const AttachedDatabaseRefreshButton: React.FC<AttachedDatabaseRefreshButtonProps> = ({ database, label, dependencies = DEFAULT_ATTACHED_DATABASE_REFRESH_DEPENDENCIES }) => {
    const refreshCatalog = dependencies.useCatalogLoaderQueue();
    const isRefreshing = isCatalogRefreshRunning(database);
    const canRefresh = canRefreshAttachedDatabase(database);

    return (
        <IconButton
            size={ButtonSize.Small}
            variant={ButtonVariant.Invisible}
            className={styles.database_refresh_button}
            aria-label={`Refresh catalog for ${label}`}
            aria-busy={isRefreshing}
            disabled={!canRefresh}
            onClick={() => refreshCatalog(database.databaseId, true)}
        >
            {isRefreshing
                ? <StatusIndicator status={IndicatorStatus.Running} width="14px" height="14px" />
                : <SyncIcon size={14} />}
        </IconButton>
    );
};

interface NotebookRowProps {
    item: NotebookItem;
    selected: boolean;
    onOpen: (anchor: HTMLButtonElement) => void;
    onDuplicate: () => void;
    onDelete: () => void;
    dependencies: NotebookWorkbenchSidebarDependencies;
}

const NotebookRow: React.FC<NotebookRowProps> = ({ item, selected, onOpen, onDuplicate, onDelete, dependencies }) => {
    const title = item.scripts.name?.trim() || null;
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.notebookId });
    return (
        <li
            ref={setNodeRef}
            className={classNames(
                styles.entry_surface,
                styles.entry_interactive,
                styles.notebook_row,
                {
                    [styles.entry_selected]: selected,
                    [styles.notebook_row_dragging]: isDragging,
                },
            )}
            style={{ transform: CSS.Translate.toString(transform), transition }}
            {...attributes}
            {...listeners}
        >
            <button
                type="button"
                className={styles.notebook_button}
                aria-current={selected ? 'page' : undefined}
                title={item.path}
                onClick={event => onOpen(event.currentTarget)}
            >
                <BookIcon size={14} aria-hidden="true" />
                <span className={title ? styles.notebook_name : styles.notebook_path}>{title ?? item.path}</span>
            </button>
            <NotebookRowMenu item={item} onDuplicate={onDuplicate} onDelete={onDelete} dependencies={dependencies} />
        </li>
    );
};

const InvalidNotebookRow: React.FC<{ item: InvalidNotebookItem; onDelete: () => void }> = ({ item, onDelete }) => (
    <li className={classNames(styles.entry_surface, styles.notebook_row)}>
        <div
            className={classNames(styles.notebook_button, styles.notebook_button_invalid)}
            title={item.invalidReason}
        >
            <AlertIcon size={14} aria-hidden="true" />
            <span>
                <span className={styles.notebook_name}>{item.label}</span>
                <span className={styles.notebook_error}>{item.invalidReason}</span>
            </span>
        </div>
        <IconButton
            size={ButtonSize.Small}
            variant={ButtonVariant.Invisible}
            className={styles.notebook_menu_button}
            aria-label={`${item.isNative ? 'Unlink' : 'Delete'} invalid notebook ${item.label}`}
            onClick={onDelete}
        >
            {item.isNative ? <UnlinkIcon size={14} /> : <TrashIcon size={14} />}
        </IconButton>
    </li>
);

export const NotebookWorkbenchSidebar: React.FC<Props> = (props) => {
    const dependencies = props.dependencies ?? DEFAULT_NOTEBOOK_WORKBENCH_SIDEBAR_DEPENDENCIES;
    const navigate = dependencies.useRouterNavigate();
    const route = dependencies.useRouteContext();
    const [databaseRegistry, databaseDispatch] = dependencies.useDynamicAttachedDatabaseDispatch();
    const [scriptsRegistry, setScriptsRegistry] = dependencies.useNotebookScriptsRegistry();
    const [, setDatabaseRegistry] = dependencies.useAttachedDatabaseRegistry();
    const allocateDatabase = dependencies.useAttachedDatabaseStateAllocator();
    const setupNotebookScripts = dependencies.useNotebookScriptsSetup();
    const deleteNotebookScripts = dependencies.useNotebookScriptsDeletion();
    const computationDispatch = dependencies.useComputationDispatch();
    const storageReader = dependencies.useStorageReader();
    const storageWriter = dependencies.useStorageWriter();
    const setupCore = dependencies.useDashQLCoreSetup();
    const notebookImport = dependencies.useNotebookImport();
    const platform = dependencies.usePlatformType();
    const logger = dependencies.useLogger();
    const { invalidNotebooks, deleteInvalidNotebook } = dependencies.useInvalidNotebookRegistry();
    const attached = dependencies.useNotebookAttachedDatabases(props.notebookScripts.notebookId);
    const attachedDatabaseRows = React.useMemo(
        () => attached == null ? [] : attachedDatabaseDisplayOrder(attached),
        [attached?.main, attached?.attached],
    );
    const [connectionOverlayDatabaseId, setConnectionOverlayDatabaseId] = React.useState<string | null>(null);
    const [createOpen, setCreateOpen] = React.useState(false);
    const createButtonRef = React.useRef<HTMLButtonElement>(null);
    const connectionSettingsAnchorRef = React.useRef<HTMLButtonElement>(null);
    const folderButtonRef = React.useRef<HTMLButtonElement>(null);
    const folderInputRef = React.useRef<HTMLInputElement>(null);
    const [notebookOrder, setNotebookOrder] = React.useState(() => storageReader.getNotebookOrder());
    const reorderWriteRef = React.useRef(Promise.resolve());
    const notebookIds = React.useMemo(
        () => [...scriptsRegistry.notebookScriptsMap.keys()],
        [scriptsRegistry],
    );

    React.useEffect(() => {
        if (route.notebookSetupStatus !== NotebookSetupStatus.CONFIGURING
            || route.notebookId !== props.notebookScripts.notebookId) return;
        const mapping = databaseRegistry.attachedDatabasesByNotebook.get(route.notebookId);
        const databaseId = mapping?.mainDatabaseId ?? null;
        if (databaseId != null) {
            connectionSettingsAnchorRef.current = document.querySelector('[aria-label="Create notebook"]');
            setConnectionOverlayDatabaseId(databaseId);
        }
    }, [databaseRegistry.attachedDatabasesByNotebook, props.notebookScripts.notebookId, route.notebookId, route.notebookSetupStatus]);

    const notebooks = React.useMemo<NotebookItem[]>(() => {
        const rank = new Map(notebookOrder.map((notebookId, index) => [notebookId, index]));
        const items: NotebookItem[] = [];
        for (const [notebookId, scripts] of scriptsRegistry.notebookScriptsMap) {
            const mapping = databaseRegistry.attachedDatabasesByNotebook.get(notebookId);
            const databaseId = mapping?.mainDatabaseId;
            const database = databaseId == null ? null : databaseRegistry.attachedDatabases.get(databaseId);
            if (database == null) continue;
            const location = storageReader.getNotebookLocation(notebookId);
            const path = displayPath(notebookId, location);
            items.push({
                notebookId,
                database,
                scripts,
                path,
                label: scripts.name?.trim() || path,
                isNative: location.type === StorageBackendType.Native,
            });
        }
        return items.sort((left, right) => {
            const leftRank = rank.get(left.notebookId) ?? Number.MAX_SAFE_INTEGER;
            const rightRank = rank.get(right.notebookId) ?? Number.MAX_SAFE_INTEGER;
            return leftRank - rightRank;
        });
    }, [databaseRegistry, scriptsRegistry, storageReader, notebookOrder]);

    React.useEffect(() => {
        const ids = notebookIds;
        setNotebookOrder(current => {
            const next = current.filter(id => ids.includes(id));
            for (const id of ids) if (!next.includes(id)) next.push(id);
            return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
        });
    }, [notebookIds]);

    const invalidItems = React.useMemo<InvalidNotebookItem[]>(() => [...invalidNotebooks.values()].map(invalid => {
        const location = storageReader.getNotebookLocation(invalid.notebookId);
        return {
            notebookId: invalid.notebookId,
            label: invalid.title,
            path: displayPath(invalid.notebookId, location),
            isNative: location.type === StorageBackendType.Native,
            invalidReason: describeNotebookValidationError(invalid.error),
        };
    }), [invalidNotebooks, storageReader]);
    const notebookCount = notebooks.length + invalidItems.length;
    const attachedDatabaseCount = attachedDatabaseRows.length;

    const dndSensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );
    const reorderNotebooks = React.useCallback((event: DragEndEvent) => {
        if (event.over == null || event.active.id === event.over.id) return;
        setNotebookOrder(current => {
            const from = current.indexOf(String(event.active.id));
            const to = current.indexOf(String(event.over!.id));
            if (from < 0 || to < 0) return current;
            const next = [...current];
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved);
            if ('reorderNotebooks' in storageReader.backend) {
                reorderWriteRef.current = reorderWriteRef.current
                    .catch(() => {})
                    .then(() => (storageReader.backend as CompositeStorageBackend).reorderNotebooks(next))
                    .catch(error => logger.warn('failed to persist notebook order', { error: String(error) }, 'notebook_workbench'));
            }
            return next;
        });
    }, [logger, storageReader.backend]);

    const createNotebook = React.useCallback((connector: ConnectorType) => {
        setCreateOpen(false);
        const notebookId = crypto.randomUUID();
        const params = createDefaultConnectionParamsForConnector(CONNECTOR_INFOS[connector]);
        const initialDatabase = connector === ConnectorType.HYPER
            ? dependencies.createDefaultHyperWasmAttachedDatabaseState(props.notebookScripts.instance, databaseRegistry.attachedDatabasesBySignature)
            : dependencies.createConnectionStateFromParams(props.notebookScripts.instance, params, databaseRegistry.attachedDatabasesBySignature);
        // The notebook is committed now; settings must not switch its initialized script dialect.
        const database = allocateDatabase(notebookId, { ...initialDatabase, active: true });
        setupNotebookScripts(notebookId, database);
        void storageWriter.write(
            groupNotebookManifestWrites(notebookId),
            { type: WRITE_NOTEBOOK_MANIFEST, value: [notebookId, database.databaseId, [database]] },
        );
        navigate({ type: SELECT_NOTEBOOK, value: notebookId });
        props.closeAfterSelection?.();
    }, [allocateDatabase, databaseRegistry.attachedDatabasesBySignature, dependencies, navigate, props.closeAfterSelection, props.notebookScripts.instance, setupNotebookScripts, storageWriter]);

    const closeConnectionOverlay = React.useCallback(() => {
        setConnectionOverlayDatabaseId(null);
        if (route.notebookSetupStatus === NotebookSetupStatus.CONFIGURING && route.notebookId != null) {
            navigate({ type: SELECT_NOTEBOOK, value: route.notebookId });
        }
    }, [navigate, route.notebookId, route.notebookSetupStatus]);

    const duplicateNotebook = React.useCallback(async (item: NotebookItem) => {
        const newNotebookId = crypto.randomUUID();
        try {
            const coreInstance = await setupCore('notebook_duplicate');
            await cloneNotebook(item.notebookId, storageReader.backend, storageWriter.backend, newNotebookId, logger);
            const restored = await restoreSingleNotebook(
                coreInstance,
                storageWriter.backend,
                logger,
                newNotebookId,
                databaseRegistry.attachedDatabasesBySignature,
            );
            setDatabaseRegistry(registry => mergeRestoredNotebookIntoConnections(registry, restored));
            setScriptsRegistry(registry => mergeRestoredNotebookIntoScripts(registry, restored));
        } catch (error) {
            logger.warn('failed to duplicate notebook', {
                notebookId: item.notebookId,
                error: String(error),
            }, 'notebook_workbench');
        }
    }, [databaseRegistry.attachedDatabasesBySignature, logger, setDatabaseRegistry, setScriptsRegistry, setupCore, storageReader.backend, storageWriter.backend]);

    const openNotebookFolder = React.useCallback(async () => {
        if (!(storageReader.backend instanceof CompositeStorageBackend)) return;
        if (platform === PlatformType.WEB) {
            folderInputRef.current?.click();
            return;
        }
        const folder = await globalThis.dashqlElectron?.openDirectory('Open an existing notebook folder');
        if (folder == null) return;
        try {
            await notebookImport.importNativeFolder(folder, {
                mode: 'anchored',
                anchorRef: folderButtonRef,
                returnFocusRef: folderButtonRef,
            });
        } catch (error) {
            logger.error('adding native notebook from folder failed', { error: String(error) }, 'notebook_workbench');
        }
    }, [logger, notebookImport, platform, storageReader.backend]);

    const openBrowserNotebookFolder = React.useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const input = event.currentTarget;
        if (input.files == null || input.files.length === 0) return;
        try {
            const bundle = await readNotebookBundleFromBrowserFolder(input.files);
            await notebookImport.importPortableBundle(bundle, {
                presentation: {
                    mode: 'anchored',
                    anchorRef: folderButtonRef,
                    returnFocusRef: folderButtonRef,
                },
            });
        } catch (error) {
            logger.error('adding browser notebook folder failed', { error: String(error) }, 'notebook_workbench');
        } finally {
            input.value = '';
        }
    }, [logger, notebookImport]);

    const deleteNotebook = React.useCallback(async (item: NotebookItem) => {
        const action = item.isNative ? 'Unlink' : 'Delete';
        if (!window.confirm(`${action} "${item.label}"?${item.isNative ? ' The folder and its files will remain on disk.' : ''}`)) return;
        try {
            await storageWriter.backend.deleteNotebook(item.notebookId);
        } catch (error) {
            console.error('Failed to delete notebook from storage:', error);
            return;
        }
        deleteNotebookScripts(item.notebookId);
        const mapping = databaseRegistry.attachedDatabasesByNotebook.get(item.notebookId);
        for (const databaseId of mapping == null ? [] : [mapping.mainDatabaseId, ...mapping.attachedDatabaseIds]) {
            if (databaseId == null) continue;
            const database = databaseRegistry.attachedDatabases.get(databaseId);
            if (database == null) continue;
            for (const queryId of [...database.queriesActiveOrdered, ...database.queriesFinishedOrdered]) {
                computationDispatch({ type: DELETE_COMPUTATION, value: [queryId] });
            }
            databaseDispatch(databaseId, { type: DELETE_ATTACHED_DATABASE, value: null });
        }

        if (item.notebookId === props.notebookScripts.notebookId) {
            const next = notebooks.find(notebook => notebook.notebookId !== item.notebookId);
            if (next != null) navigate({ type: OPEN_NOTEBOOK, value: next.notebookId });
        }
    }, [computationDispatch, databaseDispatch, databaseRegistry, deleteNotebookScripts, navigate, notebooks, props.notebookScripts.notebookId, storageWriter.backend]);

    const openNotebook = React.useCallback((item: NotebookItem) => {
        navigate({ type: SELECT_NOTEBOOK, value: item.notebookId });
        props.closeAfterSelection?.();
    }, [navigate, props.closeAfterSelection]);
    const notebookListRef = React.useRef<HTMLUListElement>(null);
    const getNotebookScrollElement = React.useCallback(() => notebookListRef.current, []);

    return (
        <nav className={styles.workbench} aria-label="Notebook workbench" data-electron-drag-region>
            <section className={styles.section} aria-labelledby="workbench-notebooks-heading">
                <header className={styles.section_header}>
                    <div className={styles.section_title}>
                        <h2 id="workbench-notebooks-heading" className={styles.section_heading}>Notebooks</h2>
                        <span
                            className={styles.section_count}
                            aria-label={`${notebookCount} ${notebookCount === 1 ? 'notebook' : 'notebooks'}`}
                        >
                            {notebookCount}
                        </span>
                    </div>
                    <div className={styles.section_actions}>
                        <dependencies.BundledNotebooksOverlay
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
                                    aria-label="Open notebook folder"
                                    onClick={openNotebookFolder}
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
                                        onChange={openBrowserNotebookFolder}
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
                                aria-label="Create notebook"
                            ><PlusIcon size={14} /></IconButton>}
                        >
                            <div className={actionMenuStyles.menu} role="dialog" aria-label="Choose notebook connector">
                                <ActionList.List aria-label="Notebook connector">
                                    {([ConnectorType.HYPER, ConnectorType.TRINO, ConnectorType.SALESFORCE_DATA_CLOUD] as const).map(connector => (
                                        <ActionList.ListItem key={connector} onClick={() => createNotebook(connector)}>
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
                    </div>
                </header>
                <div className={styles.scroll_shadow_container}>
                    <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={reorderNotebooks}>
                        <SortableContext items={notebooks.map(item => item.notebookId)} strategy={verticalListSortingStrategy}>
                            <ul ref={notebookListRef} className={styles.notebook_list} aria-label="Notebooks" data-electron-drag-region="false">
                                {notebooks.map(item => (
                                    <NotebookRow
                                        key={item.notebookId}
                                        item={item}
                                        selected={item.notebookId === props.notebookScripts.notebookId}
                                        onOpen={() => openNotebook(item)}
                                        onDuplicate={() => { void duplicateNotebook(item); }}
                                        onDelete={() => { void deleteNotebook(item); }}
                                        dependencies={dependencies}
                                    />
                                ))}
                                {invalidItems.map(item => (
                                    <InvalidNotebookRow
                                        key={item.notebookId}
                                        item={item}
                                        onDelete={() => { void deleteInvalidNotebook(item.notebookId); }}
                                    />
                                ))}
                            </ul>
                        </SortableContext>
                    </DndContext>
                    <VerticalScrollShadows
                        getScrollElement={getNotebookScrollElement}
                        refreshKey={`${notebooks.length}:${invalidItems.length}`}
                    />
                </div>
            </section>

            <section className={classNames(styles.section, styles.database_section)} aria-labelledby="workbench-databases-heading">
                <header className={styles.section_header}>
                    <div className={styles.section_title}>
                        <h2 id="workbench-databases-heading" className={styles.section_heading}>Attached Databases</h2>
                        <span
                            className={styles.section_count}
                            aria-label={`${attachedDatabaseCount} attached ${attachedDatabaseCount === 1 ? 'database' : 'databases'}`}
                        >
                            {attachedDatabaseCount}
                        </span>
                    </div>
                    <IconButton
                        size={ButtonSize.Small}
                        variant={ButtonVariant.Invisible}
                        aria-label="Attach database (not available yet)"
                        disabled
                    >
                        <PlusIcon size={14} />
                    </IconButton>
                </header>
                <div className={styles.database_body} data-electron-drag-region="false">
                    {attached && <AttachedDatabaseTree
                        databases={attachedDatabaseRows}
                        onOpenSettings={(databaseId, anchor) => {
                            connectionSettingsAnchorRef.current = anchor;
                            setConnectionOverlayDatabaseId(databaseId);
                        }}
                    />}
                </div>
            </section>
            <dependencies.ConnectionSettingsOverlay
                databaseId={connectionOverlayDatabaseId}
                isOpen={connectionOverlayDatabaseId != null}
                onClose={closeConnectionOverlay}
                anchorRef={connectionSettingsAnchorRef}
            />
        </nav>
    );
};
