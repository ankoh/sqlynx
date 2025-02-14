import * as React from 'react';
import * as ActionList from '../foundations/action_list.js';
import * as styles from './workbook_page.module.css';
import * as theme from '../../github_theme.module.css';
import * as icons from '../../../static/svg/symbols.generated.svg';

import { ButtonGroup, IconButton } from '@primer/react';
import { DownloadIcon, LinkIcon, PaperAirplaneIcon, SyncIcon, ThreeBarsIcon } from '@primer/octicons-react';

import { ConnectorInfo } from '../../connection/connector_info.js';
import { DragSizing, DragSizingBorder } from '../foundations/drag_sizing.js';
import { KeyEventHandler, useKeyEvents } from '../../utils/key_events.js';
import { QueryExecutionStatus } from '../../connection/query_execution_state.js';
import { QueryResultView } from '../query_result/query_result_view.js';
import { QueryStatusView } from '../query_status/query_status_view.js';
import { ScriptEditor } from './editor.js';
import { ScriptCatalogView } from '../../view/catalog/script_catalog_view.js';
import { ScriptURLOverlay } from './script_url_overlay.js';
import { WorkbookCommandType, useWorkbookCommandDispatch } from '../../workbook/workbook_commands.js';
import { WorkbookListDropdown } from './session_list_dropdown.js';
import { VerticalTabs, VerticalTabVariant } from '../foundations/vertical_tabs.js';
import { useAppConfig } from '../../app_config.js';
import { useCurrentWorkbookState } from '../../workbook/current_workbook.js';
import { useQueryState } from '../../connection/query_executor.js';
import { WorkbookEntryList } from './workbook_entry_list.js';

const ScriptCommandList = (props: { connector: ConnectorInfo | null }) => {
    const config = useAppConfig();
    const sessionCommand = useWorkbookCommandDispatch();
    return (
        <>
            <ActionList.ListItem
                disabled={!props.connector?.features.executeQueryAction}
                onClick={() => sessionCommand(WorkbookCommandType.ExecuteEditorQuery)}
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
                disabled={!props.connector?.features.refreshSchemaAction || !config.value?.settings?.enableCommandRefreshSchema}
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
            <ActionList.ListItem
                disabled={!props.connector?.features.executeQueryAction || !config.value?.settings?.enableCommandSaveResultsAsArrow}
            >
                <ActionList.Leading>
                    <DownloadIcon />
                </ActionList.Leading>
                <ActionList.ItemText>Save Query</ActionList.ItemText>
                <ActionList.Trailing>Ctrl + S</ActionList.Trailing>
            </ActionList.ListItem>
        </>
    );
};

enum TabKey {
    Catalog = 0,
    QueryStatusView = 1,
    QueryResultView = 2,
}

interface TabState {
    enabledTabs: number;
}

interface Props { }

export const EditorPage: React.FC<Props> = (_props: Props) => {
    const [workbook, _modifyWorkbook] = useCurrentWorkbookState();
    const [selectedTab, selectTab] = React.useState<TabKey>(TabKey.Catalog);
    const [sharingIsOpen, setSharingIsOpen] = React.useState<boolean>(false);

    // Resolve the editor query state (if any)
    const workbookEntry = workbook?.workbookEntries[workbook.selectedWorkbookEntry];
    const activeQueryId = workbookEntry?.queryId ?? null;
    const activeQueryState = useQueryState(workbook?.connectionId ?? null, activeQueryId);

    // Determine selected tabs
    const tabState = React.useRef<TabState>({
        enabledTabs: 1,
    });
    let enabledTabs = 1;
    enabledTabs += +(activeQueryState != null);
    enabledTabs += +(activeQueryState?.status == QueryExecutionStatus.SUCCEEDED);
    tabState.current.enabledTabs = enabledTabs;

    // Register keyboard events
    const keyHandlers = React.useMemo<KeyEventHandler[]>(
        () => [
            {
                key: 'j',
                ctrlKey: true,
                callback: () => {
                    selectTab(key => {
                        const tabs = [TabKey.Catalog, TabKey.QueryStatusView, TabKey.QueryResultView];
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
        const status = activeQueryState?.status ?? null;
        switch (status) {
            case null:
                selectTab(TabKey.Catalog);
                break;
            case QueryExecutionStatus.STARTED:
            case QueryExecutionStatus.ACCEPTED:
            case QueryExecutionStatus.RECEIVED_SCHEMA:
            case QueryExecutionStatus.RECEIVED_FIRST_RESULT:
                if (prevStatus.current == null || prevStatus.current[0] != activeQueryId || prevStatus.current[1] != status) {
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
        prevStatus.current = [activeQueryId, status];
    }, [activeQueryId, activeQueryState?.status]);

    const sessionCommand = useWorkbookCommandDispatch();
    return (
        <div className={styles.page}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.page_title}>Workbook</div>
                    <WorkbookListDropdown short={true} />
                </div>
                <div className={styles.header_action_container}>
                    <div>
                        <ButtonGroup className={theme.button_group}>
                            <IconButton
                                icon={PaperAirplaneIcon}
                                aria-labelledby="execute-query"
                                onClick={() => sessionCommand(WorkbookCommandType.ExecuteEditorQuery)}
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
            <div className={styles.workbook_entry_sidebar}>
                <WorkbookEntryList workbook={workbook} />
            </div>
            <div className={styles.body_container}>
                <div className={styles.editor_container}>
                    <ScriptEditor className={styles.editor_card} />
                </div>
                <DragSizing border={DragSizingBorder.Top} className={styles.output_container}>
                    <VerticalTabs
                        className={styles.output_card}
                        variant={VerticalTabVariant.Stacked}
                        selectedTab={selectedTab}
                        selectTab={selectTab}
                        tabProps={{
                            [TabKey.Catalog]: { tabId: TabKey.Catalog, icon: `${icons}#tables_connected`, labelShort: 'Catalog', disabled: false },
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
                        tabKeys={[TabKey.Catalog, TabKey.QueryStatusView, TabKey.QueryResultView]}
                        tabRenderers={{
                            [TabKey.Catalog]: _props => <ScriptCatalogView />,
                            [TabKey.QueryStatusView]: _props => (
                                <QueryStatusView query={activeQueryState} />
                            ),
                            [TabKey.QueryResultView]: _props => (
                                <QueryResultView query={activeQueryState} />
                            ),
                        }}
                    />
                </DragSizing>
            </div>
            <div className={styles.action_sidebar}>
                <ActionList.List aria-label="Actions">
                    <ActionList.GroupHeading>Connector</ActionList.GroupHeading>
                    <ScriptCommandList connector={workbook?.connectorInfo ?? null} />
                    <ActionList.GroupHeading>Output</ActionList.GroupHeading>
                    <OutputCommandList connector={workbook?.connectorInfo ?? null} />
                    <ActionList.Divider />
                </ActionList.List>
            </div>
        </div>
    );
};
