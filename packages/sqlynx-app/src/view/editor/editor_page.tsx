import * as React from 'react';

import { ActionList, IconButton, ButtonGroup, ActionMenu, Button } from '@primer/react';
import {
    SyncIcon,
    PaperAirplaneIcon,
    LinkIcon,
    DownloadIcon,
    ThreeBarsIcon,
    StackIcon,
    ArrowSwitchIcon,
    StopwatchIcon,
} from '@primer/octicons-react';

import { useConnectorList } from '../../connectors/connector_info.js';
import { ConnectorInfo, ConnectorType } from '../../connectors/connector_info.js';
import { QueryExecutionStatus } from '../../connectors/query_execution.js';
import { useCurrentSessionState } from '../../session/current_session.js';
import { ScriptEditor } from '../editor/editor.js';
import { SchemaGraph } from '../../view/schema/schema_graph.js';
import { QueryProgress } from '../../view/progress/query_progress.js';
import { DataTable } from '../../view/table/data_table.js';
import { KeyEventHandler, useKeyEvents } from '../../utils/key_events.js';
import { VerticalTabVariant, VerticalTabs } from '../vertical_tabs.js';
import { ScriptFileSaveOverlay } from '../editor/script_filesave_overlay.js';
import { ScriptURLOverlay } from '../editor/script_url_overlay.js';
import { getConnectorIcon } from '../connector_icons.js';
import { useAppConfig } from '../../app_config.js';

import * as styles from './editor_page.module.css';
import * as theme from '../../github_theme.module.css';
import * as icons from '../../../static/svg/symbols.generated.svg';
import { useConnectionState } from 'connectors/connection_registry.js';

const ConnectorSelection = (props: { className?: string; variant: 'default' | 'invisible'; short: boolean }) => {
    const connectorList = useConnectorList();
    const [sessionState, _modifySessionState] = useCurrentSessionState();
    const [isOpen, setIsOpen] = React.useState<boolean>(false);
    const selectConnector = React.useCallback((e: React.MouseEvent<HTMLLIElement, MouseEvent>) => {
        e.stopPropagation();
        const target = e.currentTarget as HTMLLIElement;
        const connectorType = Number.parseInt(target.dataset.connector ?? '0')! as ConnectorType;
        setIsOpen(false);
        // scriptStateDispatch({
        //     type: SELECT_CONNECTOR,
        //     value: connectorType,
        // });
    }, []);
    const connectorName = !sessionState?.connectorInfo
        ? 'Not set'
        : props.short
            ? sessionState?.connectorInfo.displayName.short
            : sessionState?.connectorInfo.displayName.long;
    //        <ActionMenu.Overlay width={props.short ? 'auto' : 'medium'} align="end">
    //            <ActionList>
    //                {connectorList.map((connector, i) => (
    //                    <ActionList.Item key={i} data-connector={i} onClick={selectConnector}>
    //                        <ActionList.LeadingVisual>{getConnectorIcon(connector)}</ActionList.LeadingVisual>
    //                        {props.short ? connector.displayName.short : connector.displayName.long}
    //                    </ActionList.Item>
    //                ))}
    //            </ActionList>
    //        </ActionMenu.Overlay>
    //    </ActionMenu>
    return (
        <Button
            className={props.className}
            variant={props.variant}
            alignContent="start"
            leadingVisual={() => (!sessionState?.connectorInfo ? <div /> : getConnectorIcon(sessionState?.connectorInfo))}
        >
            {connectorName}
        </Button>
    );
};

const ScriptCommandList = (props: { connector: ConnectorInfo | null }) => {
    const config = useAppConfig();
    const [linkSharingIsOpen, openLinkSharing] = React.useState<boolean>(false);
    const [saveSqlIsOpen, openSaveSql] = React.useState<boolean>(false);
    return (
        <>
            <ActionList.Item disabled={!props.connector?.features.executeQueryAction}>
                <ActionList.LeadingVisual>
                    <PaperAirplaneIcon />
                </ActionList.LeadingVisual>
                Execute Query
                <ActionList.TrailingVisual>Ctrl + E</ActionList.TrailingVisual>
            </ActionList.Item>
            <ActionList.Item disabled={true}>
                <ActionList.LeadingVisual>
                    <StopwatchIcon />
                </ActionList.LeadingVisual>
                Analyze Query
                <ActionList.TrailingVisual>Ctrl + A</ActionList.TrailingVisual>
            </ActionList.Item>
            <ActionList.Item
                disabled={!props.connector?.features.refreshSchemaAction || !config.value?.features?.refreshSchema}
            >
                <ActionList.LeadingVisual>
                    <SyncIcon />
                </ActionList.LeadingVisual>
                Refresh Schema
                <ActionList.TrailingVisual>Ctrl + R</ActionList.TrailingVisual>
            </ActionList.Item>
        </>
    );
};

const OutputCommandList = (props: { connector: ConnectorInfo | null }) => {
    const config = useAppConfig();
    const [linkSharingIsOpen, openLinkSharing] = React.useState<boolean>(false);
    const [saveSqlIsOpen, openSaveSql] = React.useState<boolean>(false);
    return (
        <>
            <ActionList.Item onClick={() => openLinkSharing(s => !s)}>
                <ActionList.LeadingVisual>
                    <LinkIcon />
                </ActionList.LeadingVisual>
                <span>
                    Share as URL
                    <ScriptURLOverlay isOpen={linkSharingIsOpen} setIsOpen={openLinkSharing} />
                </span>
                <ActionList.TrailingVisual>Ctrl + U</ActionList.TrailingVisual>
            </ActionList.Item>
            <ActionList.Item onClick={() => openSaveSql(s => !s)} disabled={!config.value?.features?.saveQueryAsSql}>
                <ActionList.LeadingVisual>
                    <DownloadIcon />
                </ActionList.LeadingVisual>
                <span>
                    Save Query Text
                    <ScriptFileSaveOverlay isOpen={saveSqlIsOpen} setIsOpen={openSaveSql} />
                </span>
                <ActionList.TrailingVisual>Ctrl + Q</ActionList.TrailingVisual>
            </ActionList.Item>
            <ActionList.Item
                disabled={!props.connector?.features.executeQueryAction || !config.value?.features?.saveResultsAsArrow}
            >
                <ActionList.LeadingVisual>
                    <DownloadIcon />
                </ActionList.LeadingVisual>
                Save Result Data
                <ActionList.TrailingVisual>Ctrl + S</ActionList.TrailingVisual>
            </ActionList.Item>
        </>
    );
};

enum TabKey {
    SchemaView = 0,
    QueryProgressView = 1,
    QueryResultView = 2,
}

interface TabState {
    enabledTabs: number;
}

interface Props { }

export const EditorPage: React.FC<Props> = (_props: Props) => {
    const [scriptState, _scriptStateDispatch] = useCurrentSessionState();
    const [selectedTab, selectTab] = React.useState<TabKey>(TabKey.SchemaView);
    const [sharingIsOpen, setSharingIsOpen] = React.useState<boolean>(false);

    // Determine selected tabs
    const tabState = React.useRef<TabState>({
        enabledTabs: 1,
    });
    let enabledTabs = 1;
    enabledTabs += +((scriptState?.queryExecutionState?.startedAt ?? null) != null);
    enabledTabs += +(scriptState?.queryExecutionResult != null);
    tabState.current.enabledTabs = enabledTabs;

    // Register keyboard events
    const keyHandlers = React.useMemo<KeyEventHandler[]>(
        () => [
            {
                key: 'j',
                ctrlKey: true,
                callback: () => {
                    selectTab(key => {
                        const tabs = [TabKey.SchemaView, TabKey.QueryProgressView, TabKey.QueryResultView];
                        return tabs[((key as number) + 1) % tabState.current.enabledTabs];
                    });
                },
            },
        ],
        [tabState, selectTab],
    );
    useKeyEvents(keyHandlers);

    // Automatically switch tabs when the execution status changes meaningfully
    const prevStatus = React.useRef<QueryExecutionStatus | null>(null);
    React.useEffect(() => {
        const status = scriptState?.queryExecutionState?.status ?? null;
        switch (status) {
            case null:
                selectTab(TabKey.SchemaView);
                break;
            case QueryExecutionStatus.STARTED:
            case QueryExecutionStatus.ACCEPTED:
            case QueryExecutionStatus.RECEIVED_SCHEMA:
            case QueryExecutionStatus.RECEIVED_FIRST_RESULT:
                if (prevStatus.current == null) {
                    selectTab(TabKey.QueryProgressView);
                }
                break;
            case QueryExecutionStatus.FAILED:
                break;
            case QueryExecutionStatus.SUCCEEDED:
                selectTab(TabKey.QueryResultView);
                break;
        }
        prevStatus.current = status;
    }, [scriptState?.queryExecutionState?.status]);

    return (
        <div className={styles.page}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.page_title}>SQL Editor</div>
                    <ConnectorSelection variant="invisible" short={true} />
                </div>
                <div className={styles.header_action_container}>
                    <div>
                        <ButtonGroup className={theme.button_group}>
                            <IconButton icon={PaperAirplaneIcon} aria-labelledby="execute-query" />
                            <IconButton icon={StopwatchIcon} aria-labelledby="analyze-query" />
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
                <VerticalTabs
                    variant={VerticalTabVariant.Stacked}
                    className={styles.output_card}
                    selectedTab={selectedTab}
                    selectTab={selectTab}
                    tabs={[
                        { tabId: TabKey.SchemaView, icon: `${icons}#tables_connected`, labelShort: 'Graph', disabled: false },
                        {
                            tabId: TabKey.QueryProgressView,
                            icon: `${icons}#plan`,
                            labelShort: 'Status',
                            disabled: tabState.current.enabledTabs < 2,
                        },
                        {
                            tabId: TabKey.QueryResultView,
                            icon: `${icons}#table`,
                            labelShort: 'Data',
                            disabled: tabState.current.enabledTabs < 3,
                        },
                    ]}
                    tabRenderers={{
                        [TabKey.SchemaView]: _props => <SchemaGraph />,
                        [TabKey.QueryProgressView]: _props => (
                            <QueryProgress
                                queryStatus={scriptState?.queryExecutionState?.status ?? null}
                                queryProgress={scriptState?.queryExecutionState?.latestProgressUpdate ?? null}
                            />
                        ),
                        [TabKey.QueryResultView]: _props => (
                            <DataTable data={scriptState?.queryExecutionResult?.resultTable ?? null} />
                        ),
                    }}
                />
                <ScriptEditor className={styles.editor_card} />
            </div>
            <div className={styles.action_sidebar}>
                <ActionList>
                    <ActionList.GroupHeading as="h2">Connector</ActionList.GroupHeading>
                    <ScriptCommandList connector={scriptState?.connectorInfo ?? null} />
                    <ActionList.Divider />
                    <ActionList.GroupHeading as="h2">Output</ActionList.GroupHeading>
                    <OutputCommandList connector={scriptState?.connectorInfo ?? null} />
                    <ActionList.Divider />
                </ActionList>
            </div>
        </div>
    );
};
