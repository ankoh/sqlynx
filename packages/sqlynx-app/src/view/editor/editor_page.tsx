import * as React from 'react';
import * as ActionList from '../foundations/action_list.js';
import * as styles from './editor_page.module.css';
import * as theme from '../../github_theme.module.css';
import * as icons from '../../../static/svg/symbols.generated.svg';

import { ButtonGroup, IconButton } from '@primer/react';
import { DownloadIcon, LinkIcon, PaperAirplaneIcon, SyncIcon, ThreeBarsIcon } from '@primer/octicons-react';

import { ConnectorInfo } from '../../connectors/connector_info.js';
import { QueryExecutionStatus } from '../../connectors/query_execution_state.js';
import { useCurrentSessionState } from '../../session/current_session.js';
import { ScriptEditor } from './editor.js';
import { SchemaGraph } from '../schema/schema_graph.js';
import { KeyEventHandler, useKeyEvents } from '../../utils/key_events.js';
import { VerticalTabs, VerticalTabVariant } from '../foundations/vertical_tabs.js';
import { ScriptFileSaveOverlay } from './script_filesave_overlay.js';
import { ScriptURLOverlay } from './script_url_overlay.js';
import { useAppConfig } from '../../app_config.js';
import { SessionListDropdown } from './session_list_dropdown.js';
import { DragSizing, DragSizingBorder } from '../foundations/drag_sizing.js';
import { useQueryState } from '../../connectors/query_executor.js';
import { QueryStatusView } from '../query_status/query_status_view.js';
import { QueryResultView } from '../query_result/query_result_view.js';
import { SessionCommandType, useSessionCommandDispatch } from '../../session/session_commands.js';

const ScriptCommandList = (props: { connector: ConnectorInfo | null }) => {
    const config = useAppConfig();
    const sessionCommand = useSessionCommandDispatch();
    return (
        <>
            <ActionList.ListItem
                disabled={!props.connector?.features.executeQueryAction}
                onClick={() => sessionCommand(SessionCommandType.ExecuteEditorQuery)}
            >
                <ActionList.Leading>
                    <PaperAirplaneIcon />
                </ActionList.Leading>
                <ActionList.ItemText>
                    Execute Query
                </ActionList.ItemText>
                <ActionList.Trailing>Ctrl + E</ActionList.Trailing>
            </ActionList.ListItem>
            <ActionList.ListItem
                disabled={!props.connector?.features.refreshSchemaAction || !config.value?.features?.refreshSchema}
            >
                <ActionList.Leading>
                    <SyncIcon />
                </ActionList.Leading>
                <ActionList.ItemText>
                    Refresh Schema
                </ActionList.ItemText>
                <ActionList.Trailing>Ctrl + R</ActionList.Trailing>
            </ActionList.ListItem>
        </>
    );
};

const OutputCommandList = (props: { connector: ConnectorInfo | null }) => {
    const config = useAppConfig();
    const [linkSharingIsOpen, openLinkSharing] = React.useState<boolean>(false);
    const [saveSqlIsOpen, openSaveSql] = React.useState<boolean>(false);
    return (
        <>
            <ActionList.ListItem onClick={() => openLinkSharing(s => !s)}>
                <ActionList.Leading>
                    <LinkIcon />
                </ActionList.Leading>
                <ActionList.ItemText>
                    Share as URL
                    <ScriptURLOverlay isOpen={linkSharingIsOpen} setIsOpen={openLinkSharing} />
                </ActionList.ItemText>
                <ActionList.Trailing>Ctrl + U</ActionList.Trailing>
            </ActionList.ListItem>
            <ActionList.ListItem onClick={() => openSaveSql(s => !s)} disabled={!config.value?.features?.saveQueryAsSql}>
                <ActionList.Leading>
                    <DownloadIcon />
                </ActionList.Leading>
                <ActionList.ItemText>
                    Save Query Text
                    <ScriptFileSaveOverlay isOpen={saveSqlIsOpen} setIsOpen={openSaveSql} />
                </ActionList.ItemText>
                <ActionList.Trailing>Ctrl + Q</ActionList.Trailing>
            </ActionList.ListItem>
            <ActionList.ListItem
                disabled={!props.connector?.features.executeQueryAction || !config.value?.features?.saveResultsAsArrow}
            >
                <ActionList.Leading>
                    <DownloadIcon />
                </ActionList.Leading>
                <ActionList.ItemText>Save Result Data</ActionList.ItemText>
                <ActionList.Trailing>Ctrl + S</ActionList.Trailing>
            </ActionList.ListItem>
        </>
    );
};

enum TabKey {
    SchemaView = 0,
    QueryStatusView = 1,
    QueryResultView = 2,
}

interface TabState {
    enabledTabs: number;
}

interface Props { }

export const EditorPage: React.FC<Props> = (_props: Props) => {
    const [currentSession, _dispatchCurrentSession] = useCurrentSessionState();
    const [selectedTab, selectTab] = React.useState<TabKey>(TabKey.SchemaView);
    const [sharingIsOpen, setSharingIsOpen] = React.useState<boolean>(false);

    // Resolve the editor query state (if any)
    const editorQuery = currentSession?.editorQuery ?? null;
    const queryState = useQueryState(currentSession?.connectionId ?? null, editorQuery);

    // Determine selected tabs
    const tabState = React.useRef<TabState>({
        enabledTabs: 1,
    });
    let enabledTabs = 1;
    enabledTabs += +(queryState != null);
    enabledTabs += +(queryState?.status == QueryExecutionStatus.SUCCEEDED);
    tabState.current.enabledTabs = enabledTabs;

    // Register keyboard events
    const keyHandlers = React.useMemo<KeyEventHandler[]>(
        () => [
            {
                key: 'j',
                ctrlKey: true,
                callback: () => {
                    selectTab(key => {
                        const tabs = [TabKey.SchemaView, TabKey.QueryStatusView, TabKey.QueryResultView];
                        return tabs[((key as number) + 1) % tabState.current.enabledTabs];
                    });
                },
            },
        ],
        [tabState, selectTab],
    );
    useKeyEvents(keyHandlers);

    // Automatically switch tabs when the execution status changes meaningfully
    const prevStatus = React.useRef<[number | null, QueryExecutionStatus | null] | null>(null);
    React.useEffect(() => {
        const status = queryState?.status ?? null;
        switch (status) {
            case null:
                selectTab(TabKey.SchemaView);
                break;
            case QueryExecutionStatus.STARTED:
            case QueryExecutionStatus.ACCEPTED:
            case QueryExecutionStatus.RECEIVED_SCHEMA:
            case QueryExecutionStatus.RECEIVED_FIRST_RESULT:
                if (prevStatus.current == null || prevStatus.current[0] != editorQuery || prevStatus.current[1] != status) {
                    selectTab(TabKey.QueryStatusView);
                }
                break;
            case QueryExecutionStatus.FAILED:
                selectTab(TabKey.QueryStatusView);
                break;
            case QueryExecutionStatus.SUCCEEDED:
                selectTab(TabKey.QueryResultView);
                break;
        }
        prevStatus.current = [editorQuery, status];
    }, [editorQuery, queryState?.status]);

    const sessionCommand = useSessionCommandDispatch();
    return (
        <div className={styles.page}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.page_title}>SQL Editor</div>
                    <SessionListDropdown short={true} />
                </div>
                <div className={styles.header_action_container}>
                    <div>
                        <ButtonGroup className={theme.button_group}>
                            <IconButton
                                icon={PaperAirplaneIcon}
                                aria-labelledby="execute-query"
                                onClick={() => sessionCommand(SessionCommandType.ExecuteEditorQuery)}
                            />
                            <IconButton icon={SyncIcon} aria-labelledby="refresh-schema" />
                            <IconButton
                                icon={LinkIcon}
                                aria-labelledby="visit-github-repository"
                                onClick={() => setSharingIsOpen(s => !s)}
                            />
                        </ButtonGroup>
                        <ScriptURLOverlay isOpen={sharingIsOpen} setIsOpen={setSharingIsOpen} />
                    </div>
                    <IconButton icon={ThreeBarsIcon} aria-labelledby="visit-github-repository" />
                </div>
            </div>
            <div className={styles.body_container}>
                <DragSizing border={DragSizingBorder.Bottom} className={styles.output_container}>
                    <VerticalTabs
                        className={styles.output_card}
                        variant={VerticalTabVariant.Stacked}
                        selectedTab={selectedTab}
                        selectTab={selectTab}
                        tabProps={{
                            [TabKey.SchemaView]: { tabId: TabKey.SchemaView, icon: `${icons}#tables_connected`, labelShort: 'Graph', disabled: false },
                            [TabKey.QueryStatusView]: {
                                tabId: TabKey.QueryStatusView,
                                icon: `${icons}#plan`,
                                labelShort: 'Status',
                                disabled: tabState.current.enabledTabs < 2,
                            },
                            [TabKey.QueryResultView]: {
                                tabId: TabKey.QueryResultView,
                                icon: `${icons}#table`,
                                labelShort: 'Data',
                                disabled: tabState.current.enabledTabs < 3,
                            },
                        }}
                        tabKeys={[TabKey.SchemaView, TabKey.QueryStatusView, TabKey.QueryResultView]}
                        tabRenderers={{
                            [TabKey.SchemaView]: _props => <SchemaGraph />,
                            [TabKey.QueryStatusView]: _props => (
                                <QueryStatusView query={queryState} />
                            ),
                            [TabKey.QueryResultView]: _props => (
                                <QueryResultView query={queryState} />
                            ),
                        }}
                    />
                </DragSizing>
                <div className={styles.editor_container}>
                    <ScriptEditor className={styles.editor_card} />
                </div>
            </div>
            <div className={styles.action_sidebar}>
                <ActionList.List aria-label="Actions">
                    <ActionList.GroupHeading>Connector</ActionList.GroupHeading>
                    <ScriptCommandList connector={currentSession?.connectorInfo ?? null} />
                    <ActionList.GroupHeading>Output</ActionList.GroupHeading>
                    <OutputCommandList connector={currentSession?.connectorInfo ?? null} />
                    <ActionList.Divider />
                </ActionList.List>
            </div>
        </div>
    );
};
