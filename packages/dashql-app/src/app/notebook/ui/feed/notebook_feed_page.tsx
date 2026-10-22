import * as React from 'react';
import * as styles from './notebook_feed_page.module.css';

import { FileDirectoryIcon, LinkIcon, PaperAirplaneIcon, SquareFillIcon, SymbolIcon, ThreeBarsIcon } from '../../../../ui/foundations/symbol_icon.js';

import { ConnectionHealth, type AttachedDatabaseState } from '../../connections/attached_database_state.js';
import {
    SELECT_SCRIPT,
    type NotebookScripts,
} from '../../scripts/notebook_scripts.js';
import type { ModifyNotebookScripts } from '../../scripts/notebook_scripts_registry.js';
import { Button, ButtonSize, ButtonVariant, IconButton } from '../../../../ui/foundations/button.js';
import { NotebookNavigationDrawer } from '../notebook_navigation_drawer.js';
import { NotebookWorkbenchSidebar } from '../notebook_workbench_sidebar.js';
import { NotebookURLShareOverlay } from '../notebook_url_share_overlay.js';
import { NotebookFileSaveOverlay } from '../notebook_file_save_overlay.js';
import { NotebookStorageOverlay } from '../../persistence/ui/notebook_storage_overlay.js';
import { ScriptDetails, TabKey as DetailsTabKey } from '../script_details.js';
import { NotebookFeed } from './notebook_feed.js';
import { Dashboard } from '../../dashboard/dashboard.js';
import { NotebookViewMode, useNotebookViewMode } from '../../scripts/notebook_commands.js';
import { SegmentedControl, SegmentedControlSize } from '../../../../ui/foundations/segmented_control.js';
import { useAppConfig } from '../../../config/app_config.js';
import { useNotebookExecution } from '../../scripts/notebook_execution_provider.js';
import { IndicatorStatus, StatusIndicator } from '../../../../ui/foundations/status_indicator.js';
import { AnchoredOverlay } from '../../../../ui/foundations/anchored_overlay.js';
import { AnchorAlignment, AnchorSide } from '../../../../ui/foundations/anchored_position.js';
import { ConnectionSettingsOverlay } from '../../connections/ui/connection_settings_overlay.js';
import { CONNECTION_HEALTH_COLORS } from '../../connections/ui/connection_status.js';
import { HYPER_CONNECTOR } from '../../connections/connector_info.js';
import { ExecuteConnectionGuard, NotebookConnectionAttentionContext, useNotebookConnectionAttention } from '../notebook_connection_attention.js';
import { useAppFlavor } from '../../../flavor/flavor_provider.js';

const FileZipIcon = SymbolIcon('file_zip_16');
const CloseIcon = SymbolIcon('x_16');

export interface NotebookFeedPageDependencies {
    NotebookFeed: typeof NotebookFeed;
    ScriptDetails: typeof ScriptDetails;
    NotebookWorkbenchSidebar: typeof NotebookWorkbenchSidebar;
    NotebookNavigationDrawer: typeof NotebookNavigationDrawer;
    ThreeBarsIcon: typeof ThreeBarsIcon;
    IconButton: typeof IconButton;
    Button: typeof Button;
    Dashboard: typeof Dashboard;
    NotebookURLShareOverlay: typeof NotebookURLShareOverlay;
    NotebookFileSaveOverlay: typeof NotebookFileSaveOverlay;
    NotebookStorageOverlay: typeof NotebookStorageOverlay;
    ConnectionSettingsOverlay: typeof ConnectionSettingsOverlay;
    useNotebookViewMode: typeof useNotebookViewMode;
    useAppConfig: typeof useAppConfig;
    SegmentedControl: typeof SegmentedControl;
    useNotebookExecution: typeof useNotebookExecution;
}

const DEFAULT_DEPENDENCIES: NotebookFeedPageDependencies = {
    NotebookFeed,
    ScriptDetails,
    NotebookWorkbenchSidebar,
    NotebookNavigationDrawer,
    ThreeBarsIcon,
    IconButton,
    Button,
    Dashboard,
    NotebookURLShareOverlay,
    NotebookFileSaveOverlay,
    NotebookStorageOverlay,
    ConnectionSettingsOverlay,
    useNotebookViewMode,
    useAppConfig,
    SegmentedControl,
    useNotebookExecution,
};

interface Props {
    notebookScripts: NotebookScripts;
    modifyNotebookScripts: ModifyNotebookScripts;
    connection: AttachedDatabaseState | null;
    active: boolean;
    dependencies?: NotebookFeedPageDependencies;
}

export const NotebookFeedPage: React.FC<Props> = (props) => {
    const dependencies = props.dependencies ?? DEFAULT_DEPENDENCIES;
    const [showDetails, setShowDetails] = React.useState(false);
    const [detailsScriptId, setDetailsScriptId] = React.useState<number | undefined>(undefined);
    const [detailsInitialTab, setDetailsInitialTab] = React.useState<DetailsTabKey | undefined>(undefined);
    const [feedShadowContainer, setFeedShadowContainer] = React.useState<HTMLDivElement | null>(null);
    const [navigationDrawerOpen, setNavigationDrawerOpen] = React.useState(false);
    const navigationDrawerTriggerRef = React.useRef<HTMLButtonElement>(null);
    const shareTriggerRef = React.useRef<HTMLButtonElement>(null);
    const exportTriggerRef = React.useRef<HTMLButtonElement>(null);
    const [shareOpen, setShareOpen] = React.useState(false);
    const [exportOpen, setExportOpen] = React.useState(false);
    const archiveExport = useAppFlavor().features.notebookArchiveExport;
    const [storageOpen, setStorageOpen] = React.useState(false);
    const [connectionOpen, setConnectionOpen] = React.useState(false);
    const connectionTriggerRef = React.useRef<HTMLButtonElement>(null);
    const connectionHealth = props.connection?.connectionHealth;
    const disconnected = connectionHealth !== ConnectionHealth.ONLINE;
    const connectionAttention = useNotebookConnectionAttention(props.notebookScripts.notebookId, props.connection?.databaseId ?? null, connectionHealth);
    const embedded = props.connection?.details?.type === HYPER_CONNECTOR && props.connection.details.value.proto.setupParams?.protocol === 'WASM';
    const connectionIdentity = embedded ? 'Embedded' : props.connection?.connectorInfo?.names.displayShort ?? 'Database';
    const connectionLabel = connectionHealth === ConnectionHealth.CONNECTING ? 'Connecting'
        : connectionHealth === ConnectionHealth.FAILED ? 'Failed' : disconnected ? 'Disconnected' : connectionIdentity;
    React.useEffect(() => setConnectionOpen(false), [props.notebookScripts.notebookId, props.connection?.databaseId]);
    const execution = dependencies.useNotebookExecution(props.notebookScripts.notebookId);
    const run = execution.state;
    const [executionDetailsOpen, setExecutionDetailsOpen] = React.useState(false);
    React.useEffect(() => setExecutionDetailsOpen(false), [props.notebookScripts.notebookId]);
    const executeRef = React.useRef<HTMLButtonElement>(null);
    const progress = run ? `${run.completedScripts}/${run.totalScripts}` : '';
    const statusText = !run ? '' : run.phase === 'planning' ? 'Planning...'
        : run.phase === 'stopping' ? `Stopping · ${progress} completed`
        : run.phase === 'failed' ? `${progress} completed`
        : run.phase === 'cancelled' ? `Stopped · ${progress} completed`
        : run.phase === 'succeeded' ? `${progress} succeeded` : `${progress} completed`;
    const { mode, setMode } = dependencies.useNotebookViewMode();
    const dashboardsEnabled = dependencies.useAppConfig()?.settings?.experimental_dashboards === true;
    const dashboardActive = dashboardsEnabled && mode === NotebookViewMode.Dashboard;
    const feedActive = props.active && !dashboardActive && !showDetails;
    // Stable since it is passed into the callbacks of every feed row
    const latestNotebookScripts = React.useRef(props.notebookScripts);
    latestNotebookScripts.current = props.notebookScripts;
    const openDetails = React.useCallback((fileName?: string, initialTab?: DetailsTabKey) => {
        const notebookScripts = latestNotebookScripts.current;
        const targetFileName = fileName ?? notebookScripts.scriptFocus.fileName;
        setDetailsScriptId(notebookScripts.scriptRefs[targetFileName]?.scriptId);
        setDetailsInitialTab(initialTab);
        setShowDetails(true);
    }, []);
    const workbench = (closeAfterSelection: boolean) => (
        <dependencies.NotebookWorkbenchSidebar
            notebookScripts={props.notebookScripts}
            closeAfterSelection={closeAfterSelection ? () => setNavigationDrawerOpen(false) : undefined}
        />
    );

    return (
        <NotebookConnectionAttentionContext.Provider value={connectionAttention}>
        <div className={styles.page}>
            <header className={styles.view_bar} data-electron-drag-region>
                <dependencies.IconButton className={styles.mobile_menu_button} ref={navigationDrawerTriggerRef} variant={ButtonVariant.Default} aria-label="Open notebook workbench" onClick={() => setNavigationDrawerOpen(true)}>
                    <dependencies.ThreeBarsIcon />
                </dependencies.IconButton>
                {dashboardsEnabled && <dependencies.SegmentedControl
                    aria-label="Notebook view"
                    size={SegmentedControlSize.Small}
                    onChange={(selectedIndex) => setMode(selectedIndex === 0
                        ? NotebookViewMode.Notebook
                        : NotebookViewMode.Dashboard)}
                >
                    <dependencies.SegmentedControl.Button selected={!dashboardActive}>Notebook</dependencies.SegmentedControl.Button>
                    <dependencies.SegmentedControl.Button selected={dashboardActive}>Dashboard</dependencies.SegmentedControl.Button>
                </dependencies.SegmentedControl>}
                <div className={styles.execution_controls}>
                    <ExecuteConnectionGuard notebookId={props.notebookScripts.notebookId} blocked={disconnected && !execution.busy}>
                    <dependencies.Button ref={executeRef} size={ButtonSize.Small} variant={ButtonVariant.Invisible}
                        leadingVisual={execution.busy ? SquareFillIcon : PaperAirplaneIcon}
                        aria-label={execution.busy ? 'Stop notebook execution' : 'Execute All'}
                        disabled={execution.busy ? run?.phase === 'stopping' : props.connection?.connectionHealth !== ConnectionHealth.ONLINE
                            || (props.connection?.queriesActive?.size ?? 0) > 0 || Object.keys(props.notebookScripts.scriptRefs).length === 0}
                        onClick={() => execution.busy ? execution.stop() : !disconnected && execution.start(props.modifyNotebookScripts)}>
                        <span className={styles.action_label}>{execution.busy ? run?.phase === 'stopping' ? 'Stopping' : 'Stop' : 'Execute All'}</span>
                    </dependencies.Button>
                    </ExecuteConnectionGuard>
                    <div className={styles.execution_status} role="status" aria-live="polite" aria-atomic="true"
                        title={run?.error ?? undefined} aria-label={run?.error ? `${statusText}: ${run.error}` : undefined}>
                        {run && <>
                            <AnchoredOverlay
                                open={executionDetailsOpen} onOpen={() => setExecutionDetailsOpen(true)} onClose={() => setExecutionDetailsOpen(false)}
                                side={AnchorSide.OutsideBottom} align={AnchorAlignment.Start} anchorOffset={4}
                                renderAnchor={anchorProps => <dependencies.Button {...anchorProps}
                                    size={ButtonSize.Small} variant={ButtonVariant.Invisible} aria-label="Show notebook execution details"
                                    leadingVisual={<span className={styles.execution_indicator} aria-hidden="true"><StatusIndicator width="16px" height="16px" status={execution.busy
                                        ? IndicatorStatus.Running : run.phase === 'failed' ? IndicatorStatus.Failed
                                            : run.phase === 'succeeded' ? IndicatorStatus.Succeeded : IndicatorStatus.Skip} /></span>}>
                                    <span className={styles.execution_progress}>{statusText}</span>
                                </dependencies.Button>}>
                                <section className={styles.execution_error_card} role="dialog" aria-label="Notebook execution details">
                                    <header className={styles.execution_error_header}>
                                        <h2 className={styles.execution_details_title}>{run.phase === 'failed' ? 'Execution failed' : 'Notebook execution'}</h2>
                                        <dependencies.IconButton size={ButtonSize.Small} variant={ButtonVariant.Invisible}
                                            aria-label="Close notebook execution details" onClick={() => setExecutionDetailsOpen(false)}>
                                            <CloseIcon size={16} />
                                        </dependencies.IconButton>
                                    </header>
                                    <div className={styles.execution_details_body}>
                                        <div>{statusText}</div>
                                        {run.activeFileName && <div>{run.activeFileName} · statement {run.activeStatementIndex}/{run.activeStatementCount}</div>}
                                        <div>{run.completedStatements}/{run.totalStatements} statements completed</div>
                                        {run.error && <div className={styles.execution_error_message}>{run.error}</div>}
                                    </div>
                                </section>
                            </AnchoredOverlay>
                        </>}
                    </div>
                </div>
                <div className={styles.header_actions}>
                    <dependencies.Button ref={connectionTriggerRef} size={ButtonSize.Small}
                        variant={ButtonVariant.Invisible}
                        leadingVisual={<span aria-hidden="true" className={styles.connection_spinner}>
                            {connectionHealth === ConnectionHealth.CONNECTING
                                ? <StatusIndicator width="16px" height="16px" status={IndicatorStatus.Running} />
                                : <svg width="16px" height="16px" viewBox="0 0 16 16">
                                    <circle cx="8" cy="8" r="4" fill={CONNECTION_HEALTH_COLORS[connectionHealth ?? ConnectionHealth.NOT_STARTED]} />
                                </svg>}
                        </span>}
                        className={`${styles.connection_action} ${connectionAttention.active && disconnected ? styles.connection_attention : ''}`}
                        data-connection-attention={connectionAttention.active && disconnected ? 'true' : undefined}
                        aria-label={`${connectionLabel}: main execution database${embedded ? ' (embedded)' : ''}`}
                        aria-expanded={connectionOpen} aria-haspopup="dialog"
                        title={disconnected ? 'Connect to execute queries' : `${connectionIdentity} connection settings`}
                        onClick={() => {
                            setShareOpen(false);
                            setExportOpen(false);
                            setStorageOpen(false);
                            setConnectionOpen(value => !value);
                        }}>
                        <span className={styles.connection_label}>{connectionLabel}</span>
                    </dependencies.Button>
                    <dependencies.ConnectionSettingsOverlay databaseId={props.connection?.databaseId ?? null}
                        isOpen={connectionOpen} onClose={() => setConnectionOpen(false)} anchorRef={connectionTriggerRef}
                        side={AnchorSide.OutsideBottom} />
                    <dependencies.Button ref={shareTriggerRef} size={ButtonSize.Small} variant={ButtonVariant.Invisible} leadingVisual={LinkIcon} aria-label="Share as URL" aria-expanded={shareOpen} onClick={() => {
                        setExportOpen(false);
                        setConnectionOpen(false);
                        setStorageOpen(false);
                        setShareOpen(value => !value);
                    }}>
                        <span className={styles.action_label}>Share as URL</span>
                    </dependencies.Button>
                    <dependencies.NotebookURLShareOverlay notebookId={props.notebookScripts.notebookId} isOpen={shareOpen} setIsOpen={setShareOpen} anchorRef={shareTriggerRef} />
                    {archiveExport && (
                        <>
                            <dependencies.Button ref={exportTriggerRef} size={ButtonSize.Small} variant={ButtonVariant.Invisible} leadingVisual={FileZipIcon} aria-label="Export .dashql" aria-expanded={exportOpen} onClick={() => {
                                setShareOpen(false);
                                setConnectionOpen(false);
                                setStorageOpen(false);
                                setExportOpen(value => !value);
                            }}>
                                <span className={styles.action_label}>Export .dashql</span>
                            </dependencies.Button>
                            <dependencies.NotebookFileSaveOverlay
                                isOpen={exportOpen}
                                setIsOpen={setExportOpen}
                                anchorRef={exportTriggerRef}
                                conn={props.connection}
                                notebookScripts={props.notebookScripts}
                                fileName={props.notebookScripts.name ?? props.notebookScripts.notebookMetadata.originalFileName ?? 'notebook'}
                            />
                        </>
                    )}
                    <dependencies.NotebookStorageOverlay
                        notebookId={props.notebookScripts.notebookId}
                        isOpen={storageOpen}
                        onOpen={() => {
                            setShareOpen(false);
                            setConnectionOpen(false);
                            setExportOpen(false);
                            setStorageOpen(true);
                        }}
                        onClose={() => setStorageOpen(false)}
                        renderAnchor={(anchorProps) => (
                            <dependencies.Button {...anchorProps} size={ButtonSize.Small} variant={ButtonVariant.Invisible} leadingVisual={FileDirectoryIcon} aria-label="Storage">
                                <span className={styles.action_label}>Storage</span>
                            </dependencies.Button>
                        )}
                    />
                </div>
            </header>
            <aside className={styles.navigation_sidebar}>
                {workbench(false)}
            </aside>
            <main className={styles.body_container} id="notebook-body">
                <div className={styles.content_container}>
                    <div className={feedActive ? styles.feed_layer : styles.feed_layer_hidden}>
                        <dependencies.NotebookFeed
                            notebookScripts={props.notebookScripts}
                            modifyNotebookScripts={props.modifyNotebookScripts}
                            active={feedActive}
                            scrollShadowContainer={feedShadowContainer}
                            showDetails={openDetails}
                            conn={props.connection}
                        />
                    </div>
                    {!dashboardActive && showDetails
                                ? <dependencies.ScriptDetails
                                    notebookScripts={props.notebookScripts}
                                    modifyNotebookScripts={props.modifyNotebookScripts}
                                    connection={props.connection}
                                    hideDetails={() => {
                                        setShowDetails(false);
                                        setDetailsScriptId(undefined);
                                        setDetailsInitialTab(undefined);
                                    }}
                                    scriptId={detailsScriptId}
                                    initialTab={detailsInitialTab}
                                    navigateToScript={(scriptKey) => {
                                        const target = props.notebookScripts.scripts[scriptKey];
                                        if (!target?.fileName) return;
                                        props.modifyNotebookScripts({
                                            type: SELECT_SCRIPT,
                                            value: target.fileName,
                                        });
                                        setDetailsScriptId(scriptKey);
                                        setDetailsInitialTab(undefined);
                                    }}
                                />
                                : null}
                    {dashboardActive && (
                        <dependencies.Dashboard
                            notebookScripts={props.notebookScripts}
                            modifyNotebookScripts={props.modifyNotebookScripts}
                        />
                    )}
                    <div
                        ref={setFeedShadowContainer}
                        className={dashboardActive ? styles.feed_shadow_layer_hidden : styles.feed_shadow_layer}
                        aria-hidden="true"
                    />
                </div>
            </main>
            {navigationDrawerOpen && (
                <dependencies.NotebookNavigationDrawer open onClose={() => setNavigationDrawerOpen(false)} returnFocusRef={navigationDrawerTriggerRef}>
                    {workbench(true)}
                </dependencies.NotebookNavigationDrawer>
            )}
        </div>
        </NotebookConnectionAttentionContext.Provider>
    );
};
