import * as React from 'react';
import * as styles from './session_feed_page.module.css';

import { FileDirectoryIcon, LinkIcon, PaperAirplaneIcon, SquareFillIcon, SymbolIcon, ThreeBarsIcon } from '../../../../ui/foundations/symbol_icon.js';

import { ConnectionHealth, type ConnectionState } from '../../../connections/connection_state.js';
import {
    SELECT_SCRIPT,
    type SessionScripts,
} from '../../scripts/session_scripts.js';
import type { ModifySessionScripts } from '../../scripts/session_scripts_registry.js';
import { Button, ButtonSize, ButtonVariant, IconButton } from '../../../../ui/foundations/button.js';
import { SessionNavigationDrawer } from '../session_navigation_drawer.js';
import { SessionWorkbenchSidebar } from '../session_workbench_sidebar.js';
import { SessionURLShareOverlay } from '../session_url_share_overlay.js';
import { SessionFileSaveOverlay } from '../session_file_save_overlay.js';
import { SessionStorageOverlay } from '../../persistence/ui/session_storage_overlay.js';
import { ScriptDetails, TabKey as DetailsTabKey } from '../script_details.js';
import { SessionFeed } from './session_feed.js';
import { Dashboard } from '../../dashboard/dashboard.js';
import { SessionViewMode, useSessionViewMode } from '../../scripts/session_commands.js';
import { SegmentedControl, SegmentedControlSize } from '../../../../ui/foundations/segmented_control.js';
import { useAppConfig } from '../../../config/app_config.js';
import { useSessionExecution } from '../../scripts/session_execution_provider.js';
import { IndicatorStatus, StatusIndicator } from '../../../../ui/foundations/status_indicator.js';
import { AnchoredOverlay } from '../../../../ui/foundations/anchored_overlay.js';
import { AnchorAlignment, AnchorSide } from '../../../../ui/foundations/anchored_position.js';
import { ExecuteConnectionGuard, SessionConnectionAttentionContext, useSessionConnectionAttention } from '../session_connection_attention.js';
import { useAppFlavor } from '../../../flavor/flavor_provider.js';

const FileZipIcon = SymbolIcon('file_zip_16');
const CloseIcon = SymbolIcon('x_16');

export interface SessionFeedPageDependencies {
    SessionFeed: typeof SessionFeed;
    ScriptDetails: typeof ScriptDetails;
    SessionWorkbenchSidebar: typeof SessionWorkbenchSidebar;
    SessionNavigationDrawer: typeof SessionNavigationDrawer;
    ThreeBarsIcon: typeof ThreeBarsIcon;
    IconButton: typeof IconButton;
    Button: typeof Button;
    Dashboard: typeof Dashboard;
    SessionURLShareOverlay: typeof SessionURLShareOverlay;
    SessionFileSaveOverlay: typeof SessionFileSaveOverlay;
    SessionStorageOverlay: typeof SessionStorageOverlay;
    useSessionViewMode: typeof useSessionViewMode;
    useAppConfig: typeof useAppConfig;
    SegmentedControl: typeof SegmentedControl;
    useSessionExecution: typeof useSessionExecution;
}

const DEFAULT_DEPENDENCIES: SessionFeedPageDependencies = {
    SessionFeed,
    ScriptDetails,
    SessionWorkbenchSidebar,
    SessionNavigationDrawer,
    ThreeBarsIcon,
    IconButton,
    Button,
    Dashboard,
    SessionURLShareOverlay,
    SessionFileSaveOverlay,
    SessionStorageOverlay,
    useSessionViewMode,
    useAppConfig,
    SegmentedControl,
    useSessionExecution,
};

interface Props {
    sessionScripts: SessionScripts;
    modifySessionScripts: ModifySessionScripts;
    connection: ConnectionState | null;
    /// The connections that the scripts of the session run on
    scriptConnections?: ReadonlyMap<string, ConnectionState>;
    active: boolean;
    dependencies?: SessionFeedPageDependencies;
}

export const SessionFeedPage: React.FC<Props> = (props) => {
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
    const archiveExport = useAppFlavor().features.sessionArchiveExport;
    const [storageOpen, setStorageOpen] = React.useState(false);
    const connectionHealth = props.connection?.connectionHealth;
    const disconnected = connectionHealth !== ConnectionHealth.ONLINE;
    const connectionAttention = useSessionConnectionAttention(props.sessionScripts.sessionId, props.connection?.connectionId ?? null, connectionHealth);
    // A session run takes every connection that a script runs on
    const scriptConnections = props.scriptConnections ?? new Map(props.connection == null ? [] : [[props.connection.connectionId, props.connection]]);
    const scriptConnectionsIdle = scriptConnections.size > 0 && [...scriptConnections.values()].every(connection =>
        connection.connectionHealth === ConnectionHealth.ONLINE && (connection.queriesActive?.size ?? 0) === 0);
    const execution = dependencies.useSessionExecution(props.sessionScripts.sessionId);
    const run = execution.state;
    const [executionDetailsOpen, setExecutionDetailsOpen] = React.useState(false);
    React.useEffect(() => setExecutionDetailsOpen(false), [props.sessionScripts.sessionId]);
    const executeRef = React.useRef<HTMLButtonElement>(null);
    const progress = run ? `${run.completedScripts}/${run.totalScripts}` : '';
    const statusText = !run ? '' : run.phase === 'planning' ? 'Planning...'
        : run.phase === 'stopping' ? `Stopping · ${progress} completed`
        : run.phase === 'failed' ? `${progress} completed`
        : run.phase === 'cancelled' ? `Stopped · ${progress} completed`
        : run.phase === 'succeeded' ? `${progress} succeeded` : `${progress} completed`;
    const { mode, setMode } = dependencies.useSessionViewMode();
    const dashboardsEnabled = dependencies.useAppConfig()?.settings?.experimental_dashboards === true;
    const dashboardActive = dashboardsEnabled && mode === SessionViewMode.Dashboard;
    const feedActive = props.active && !dashboardActive && !showDetails;
    // Stable since it is passed into the callbacks of every feed row
    const latestSessionScripts = React.useRef(props.sessionScripts);
    latestSessionScripts.current = props.sessionScripts;
    const openDetails = React.useCallback((fileName?: string, initialTab?: DetailsTabKey) => {
        const sessionScripts = latestSessionScripts.current;
        const targetFileName = fileName ?? sessionScripts.scriptFocus.fileName;
        setDetailsScriptId(sessionScripts.scriptRefs[targetFileName]?.scriptId);
        setDetailsInitialTab(initialTab);
        setShowDetails(true);
    }, []);
    const workbench = (closeAfterSelection: boolean) => (
        <dependencies.SessionWorkbenchSidebar
            sessionScripts={props.sessionScripts}
            closeAfterSelection={closeAfterSelection ? () => setNavigationDrawerOpen(false) : undefined}
        />
    );

    return (
        <SessionConnectionAttentionContext.Provider value={connectionAttention}>
        <div className={styles.page}>
            <header className={styles.view_bar} data-electron-drag-region>
                <dependencies.IconButton className={styles.mobile_menu_button} ref={navigationDrawerTriggerRef} variant={ButtonVariant.Default} aria-label="Open session workbench" onClick={() => setNavigationDrawerOpen(true)}>
                    <dependencies.ThreeBarsIcon />
                </dependencies.IconButton>
                {dashboardsEnabled && <dependencies.SegmentedControl
                    aria-label="Session view"
                    size={SegmentedControlSize.Small}
                    onChange={(selectedIndex) => setMode(selectedIndex === 0
                        ? SessionViewMode.Session
                        : SessionViewMode.Dashboard)}
                >
                    <dependencies.SegmentedControl.Button selected={!dashboardActive}>Session</dependencies.SegmentedControl.Button>
                    <dependencies.SegmentedControl.Button selected={dashboardActive}>Dashboard</dependencies.SegmentedControl.Button>
                </dependencies.SegmentedControl>}
                <div className={styles.execution_controls}>
                    <ExecuteConnectionGuard sessionId={props.sessionScripts.sessionId} blocked={disconnected && !execution.busy}>
                    <dependencies.Button ref={executeRef} size={ButtonSize.Small} variant={ButtonVariant.Invisible}
                        leadingVisual={execution.busy ? SquareFillIcon : PaperAirplaneIcon}
                        aria-label={execution.busy ? 'Stop session execution' : 'Execute All'}
                        disabled={execution.busy ? run?.phase === 'stopping' : !scriptConnectionsIdle
                            || props.sessionScripts.scriptOrder.length === 0}
                        onClick={() => execution.busy ? execution.stop() : !disconnected && execution.start(props.modifySessionScripts)}>
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
                                    size={ButtonSize.Small} variant={ButtonVariant.Invisible} aria-label="Show session execution details"
                                    leadingVisual={<span className={styles.execution_indicator} aria-hidden="true"><StatusIndicator width="16px" height="16px" status={execution.busy
                                        ? IndicatorStatus.Running : run.phase === 'failed' ? IndicatorStatus.Failed
                                            : run.phase === 'succeeded' ? IndicatorStatus.Succeeded : IndicatorStatus.Skip} /></span>}>
                                    <span className={styles.execution_progress}>{statusText}</span>
                                </dependencies.Button>}>
                                <section className={styles.execution_error_card} role="dialog" aria-label="Session execution details">
                                    <header className={styles.execution_error_header}>
                                        <h2 className={styles.execution_details_title}>{run.phase === 'failed' ? 'Execution failed' : 'Session execution'}</h2>
                                        <dependencies.IconButton size={ButtonSize.Small} variant={ButtonVariant.Invisible}
                                            aria-label="Close session execution details" onClick={() => setExecutionDetailsOpen(false)}>
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
                    <dependencies.Button ref={shareTriggerRef} size={ButtonSize.Small} variant={ButtonVariant.Invisible} leadingVisual={LinkIcon} aria-label="Share as URL" aria-expanded={shareOpen} onClick={() => {
                        setExportOpen(false);
                        setStorageOpen(false);
                        setShareOpen(value => !value);
                    }}>
                        <span className={styles.action_label}>Share as URL</span>
                    </dependencies.Button>
                    <dependencies.SessionURLShareOverlay sessionId={props.sessionScripts.sessionId} isOpen={shareOpen} setIsOpen={setShareOpen} anchorRef={shareTriggerRef} />
                    {archiveExport && (
                        <>
                            <dependencies.Button ref={exportTriggerRef} size={ButtonSize.Small} variant={ButtonVariant.Invisible} leadingVisual={FileZipIcon} aria-label="Export .dashql" aria-expanded={exportOpen} onClick={() => {
                                setShareOpen(false);
                                        setStorageOpen(false);
                                setExportOpen(value => !value);
                            }}>
                                <span className={styles.action_label}>Export .dashql</span>
                            </dependencies.Button>
                            <dependencies.SessionFileSaveOverlay
                                isOpen={exportOpen}
                                setIsOpen={setExportOpen}
                                anchorRef={exportTriggerRef}
                                conn={props.connection}
                                sessionScripts={props.sessionScripts}
                                fileName={props.sessionScripts.name ?? props.sessionScripts.sessionMetadata.originalFileName ?? 'session'}
                            />
                        </>
                    )}
                    <dependencies.SessionStorageOverlay
                        sessionId={props.sessionScripts.sessionId}
                        isOpen={storageOpen}
                        onOpen={() => {
                            setShareOpen(false);
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
            <main className={styles.body_container} id="session-body">
                <div className={styles.content_container}>
                    <div className={feedActive ? styles.feed_layer : styles.feed_layer_hidden}>
                        <dependencies.SessionFeed
                            sessionScripts={props.sessionScripts}
                            modifySessionScripts={props.modifySessionScripts}
                            active={feedActive}
                            scrollShadowContainer={feedShadowContainer}
                            showDetails={openDetails}
                            conn={props.connection}
                            scriptConnections={props.scriptConnections}
                        />
                    </div>
                    {!dashboardActive && showDetails
                                ? <dependencies.ScriptDetails
                                    sessionScripts={props.sessionScripts}
                                    modifySessionScripts={props.modifySessionScripts}
                                    connection={props.connection}
                                    scriptConnections={props.scriptConnections}
                                    hideDetails={() => {
                                        setShowDetails(false);
                                        setDetailsScriptId(undefined);
                                        setDetailsInitialTab(undefined);
                                    }}
                                    scriptId={detailsScriptId}
                                    initialTab={detailsInitialTab}
                                    navigateToScript={(scriptKey) => {
                                        const target = props.sessionScripts.scripts[scriptKey];
                                        if (!target?.fileName) return;
                                        props.modifySessionScripts({
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
                            sessionScripts={props.sessionScripts}
                            modifySessionScripts={props.modifySessionScripts}
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
                <dependencies.SessionNavigationDrawer open onClose={() => setNavigationDrawerOpen(false)} returnFocusRef={navigationDrawerTriggerRef}>
                    {workbench(true)}
                </dependencies.SessionNavigationDrawer>
            )}
        </div>
        </SessionConnectionAttentionContext.Provider>
    );
};
