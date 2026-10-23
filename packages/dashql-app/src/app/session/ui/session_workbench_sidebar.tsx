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

import { useComputationDispatch } from '../../../compute/computation_registry.js';
import { DELETE_COMPUTATION } from '../../../compute/computation_state.js';
import { AnchorAlignment, AnchorSide } from '../../../ui/foundations/anchored_position.js';
import { AnchoredOverlay } from '../../../ui/foundations/anchored_overlay.js';
import * as ActionList from '../../../ui/foundations/action_list.js';
import { ButtonSize, ButtonVariant, IconButton } from '../../../ui/foundations/button.js';
import {
    AlertIcon,
    CopyIcon,
    FileDirectoryIcon,
    LinkIcon,
    PlusIcon,
    TrashIcon,
    SymbolIcon,
    UnlinkIcon,
    UploadIcon,
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
    useConnectionReferences,
    useConnectionRegistry,
    useConnectionAllocator,
    useSessionConnections,
    useDynamicConnectionDispatch,
} from '../../connections/connection_registry.js';
import {
    createDefaultHyperWasmConnectionState,
    createConnectionStateFromParams,
    createDefaultConnectionParamsForConnector,
} from '../../connections/connection_params.js';
import { CONNECTOR_INFOS, ConnectorType } from '../../connections/connector_info.js';
import { ConnectionSettingsOverlay } from '../../connections/ui/connection_settings_overlay.js';
import { renderSessionName } from './session_name.js';
import { SessionConnectionAttentionContext } from './session_connection_attention.js';
import { VerticalScrollShadows } from '../../../ui/foundations/vertical_scroll_shadows.js';
import { displayPath } from '../../storage/session_locator.js';
import { StorageBackendType } from '../../storage/storage_backend.js';
import { SessionStorageOverlay } from '../persistence/ui/session_storage_overlay.js';
import { useStorageReader, useStorageWriter } from '../../storage/storage_provider.js';
import { readSessionBundleFromBrowserFolder } from '../persistence/browser_session_folder.js';
import { cloneSession } from '../../storage/session_transfer.js';
import {
    mergeRestoredSessionIntoConnections,
    mergeRestoredSessionIntoScripts,
    restoreSingleSession,
} from '../persistence/app_state_loader.js';
import { useSessionImport } from '../persistence/session_import_provider.js';
import { describeSessionValidationError } from '../../storage/session_validation.js';
import type { SessionScripts } from '../scripts/session_scripts.js';
import {
    useInvalidSessions,
    useSessionScriptsDeletion,
    useSessionScriptsRegistry,
} from '../scripts/session_scripts_registry.js';
import { useSessionCreation } from '../session_creation.js';
import { BundledSessionsOverlay } from '../../ui/bundled_sessions_overlay.js';
import { connectionLabelParts, connectionLabelText, connectionOrdinals, type ConnectionLabelParts } from '../../connections/ui/connection_label.js';
import { ConnectionProtocolTag } from '../../connections/ui/connection_label_view.js';
import { useAppFlavor } from '../../flavor/flavor_provider.js';
import { SessionURLShareOverlay } from './session_url_share_overlay.js';
import { SessionFileSaveOverlay } from './session_file_save_overlay.js';
import * as styles from './session_workbench_sidebar.module.css';
import { ConnectionTree, connectionDisplayOrder, isConnectionInitiallyExpanded, listedConnections, type ConnectionUsage } from '../../connections/ui/connection_tree.js';
import * as actionMenuStyles from '../../ui/action_menu.module.css';
import { useDashQLCoreSetup } from '../../providers/core_provider.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import { PlatformType, usePlatformType } from '../../../platform/platform_type.js';

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
    /// The connection whose overview is open
    openOverviewId?: string | null;
    /// Open the overview of a connection, or close it with null
    onOpenOverview?: (connectionId: string | null) => void;
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
    useSessionCreation: typeof useSessionCreation;
    useSessionScriptsDeletion: typeof useSessionScriptsDeletion;
    useComputationDispatch: typeof useComputationDispatch;
    useStorageReader: typeof useStorageReader;
    useStorageWriter: typeof useStorageWriter;
    useDashQLCoreSetup: typeof useDashQLCoreSetup;
    useSessionImport: typeof useSessionImport;
    usePlatformType: typeof usePlatformType;
    useLogger: typeof useLogger;
    useInvalidSessions: typeof useInvalidSessions;
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
    useSessionCreation,
    useSessionScriptsDeletion,
    useComputationDispatch,
    useStorageReader,
    useStorageWriter,
    useDashQLCoreSetup,
    useSessionImport,
    usePlatformType,
    useLogger,
    useInvalidSessions,
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
const FileZipIcon = SymbolIcon('file_zip_16');

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
                <FileDirectoryIcon size={14} aria-hidden="true" />
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
    const createSession = dependencies.useSessionCreation();
    const deleteSessionScripts = dependencies.useSessionScriptsDeletion();
    const computationDispatch = dependencies.useComputationDispatch();
    const storageReader = dependencies.useStorageReader();
    const storageWriter = dependencies.useStorageWriter();
    const setupCore = dependencies.useDashQLCoreSetup();
    const sessionImport = dependencies.useSessionImport();
    const platform = dependencies.usePlatformType();
    const logger = dependencies.useLogger();
    const { invalidSessions, deleteInvalidSession } = dependencies.useInvalidSessions();
    const attached = dependencies.useSessionConnections(props.sessionScripts.sessionId);
    const connectionAttention = React.useContext(SessionConnectionAttentionContext);
    const sessionConnectionRows = React.useMemo(
        () => attached == null ? [] : connectionDisplayOrder(attached),
        [attached?.main, attached?.attached],
    );
    const [connectionOverlayDatabaseId, setConnectionOverlayDatabaseId] = React.useState<string | null>(null);
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
            const sessionFolders = storageReader.sessionFolders;
            if (sessionFolders != null) {
                reorderWriteRef.current = reorderWriteRef.current
                    .catch(() => {})
                    .then(() => sessionFolders.reorderSessions(next))
                    .catch(error => logger.warn('failed to persist session order', { error: String(error) }, 'session_workbench'));
            }
            return next;
        });
    }, [logger, storageReader.sessionFolders]);

    /// Create a session that uses an existing connection
    const createSessionWithConnection = React.useCallback((database: ConnectionState) => {
        setCreateOpen(false);
        const { sessionId } = createSession(database);
        navigate({ type: SELECT_SESSION, value: sessionId });
        props.closeAfterSelection?.();
    }, [createSession, navigate, props.closeAfterSelection]);

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

    /// Create a session with a new connection of a connector
    const createSessionWithConnector = React.useCallback((connector: ConnectorType) => {
        setCreateOpen(false);
        const params = createDefaultConnectionParamsForConnector(CONNECTOR_INFOS[connector]);
        const initialDatabase = connector === ConnectorType.HYPER
            ? dependencies.createDefaultHyperWasmConnectionState(props.sessionScripts.instance)
            : dependencies.createConnectionStateFromParams(props.sessionScripts.instance, params);
        // The session is committed now; settings must not switch its initialized script dialect.
        const database = allocateConnection({ ...initialDatabase, active: true });
        const { sessionId } = createSession(database);
        navigate({ type: SELECT_SESSION, value: sessionId });
        props.closeAfterSelection?.();
    }, [allocateConnection, createSession, dependencies, navigate, props.closeAfterSelection, props.sessionScripts.instance]);

    const closeConnectionOverlay = React.useCallback(() => {
        setConnectionOverlayDatabaseId(null);
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
        if (storageReader.sessionFolders == null) return;
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
    }, [logger, sessionImport, platform, storageReader.sessionFolders]);

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
            await storageWriter.deleteSession(item.sessionId);
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
    }, [computationDispatch, deleteSessionScripts, navigate, sessions, props.sessionScripts.sessionId, storageWriter]);

    const openSession = React.useCallback((item: SessionItem) => {
        navigate({ type: SELECT_SESSION, value: item.sessionId });
        props.onOpenOverview?.(null);
        props.closeAfterSelection?.();
    }, [navigate, props.closeAfterSelection, props.onOpenOverview]);
    const onOpenOverview = props.onOpenOverview;
    const closeAfterSelection = props.closeAfterSelection;
    const openOverview = React.useMemo(() => onOpenOverview == null ? undefined : (connectionId: string) => {
        onOpenOverview(connectionId);
        closeAfterSelection?.();
    }, [onOpenOverview, closeAfterSelection]);
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
                        {storageReader.sessionFolders != null && (
                            <>
                                <IconButton
                                    ref={folderButtonRef}
                                    size={ButtonSize.Small}
                                    variant={ButtonVariant.Invisible}
                                    aria-label="Open session folder"
                                    onClick={openSessionFolder}
                                >
                                    <UploadIcon size={14} />
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
                                        <ActionList.ListItem key={connector} onClick={() => createSessionWithConnector(connector)}>
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
                        attention={connectionAttention?.active === true}
                        onOpenOverview={openOverview}
                        openOverviewId={props.openOverviewId ?? null}
                        onOpenSettings={(connectionId, anchor) => {
                            connectionSettingsAnchorRef.current = anchor;
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
            />
        </nav>
    );
};
