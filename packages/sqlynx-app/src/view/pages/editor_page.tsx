import * as React from 'react';
import * as arrow from 'apache-arrow';

import { ActionList, IconButton, ButtonGroup, ActionMenu } from '@primer/react';
import {
    SyncIcon,
    PaperAirplaneIcon,
    LinkIcon,
    DownloadIcon,
    ThreeBarsIcon,
    ArrowSwitchIcon,
} from '@primer/octicons-react';

import {
    SELECT_CONNECTOR,
    useSelectedConnector,
    useConnectorList,
    useConnectorSelection,
} from '../../connectors/connector_selection';
import { ConnectorInfo, ConnectorType } from '../../connectors/connector_info';
import { QueryExecutionTaskStatus } from '../../connectors/query_execution';
import { useScriptState } from '../../scripts/script_state_provider';
import { ScriptEditor } from '../editor/editor';
import { SchemaGraph } from '../../view/schema/schema_graph';
import { QueryProgress } from '../../view/progress/query_progress';
import { DataTable } from '../../view/table/data_table';
import { KeyEventHandler, useKeyEvents } from '../../utils/key_events';
import { TabCard } from '../../view/tab_card';
import { ScriptFileSaveOverlay } from '../editor/script_filesave_overlay';
import { ScriptURLOverlay } from '../editor/script_url_overlay';
import { getConnectorIcon } from '../connector_icons';

import styles from './editor_page.module.css';
import primerBugFixes from '../../primer_bugfixes.module.css';
import icons from '../../../static/svg/symbols.generated.svg';

interface Props {}

const ConnectorSelection = (props: { className?: string; variant: 'default' | 'invisible'; short: boolean }) => {
    const connectorList = useConnectorList();
    const connectorSelection = useConnectorSelection();
    const connector = useSelectedConnector();
    const [isOpen, setIsOpen] = React.useState<boolean>(false);
    const selectConnector = React.useCallback((e: React.MouseEvent<HTMLLIElement, MouseEvent>) => {
        e.stopPropagation();
        const target = e.currentTarget as HTMLLIElement;
        const connectorType = Number.parseInt(target.dataset.connector ?? '0')! as ConnectorType;
        setIsOpen(false);
        connectorSelection({
            type: SELECT_CONNECTOR,
            value: connectorType,
        });
    }, []);
    return (
        <ActionMenu open={isOpen} onOpenChange={setIsOpen}>
            <ActionMenu.Button
                className={props.className}
                variant={props.variant}
                alignContent="start"
                leadingVisual={() => getConnectorIcon(connector)}
            >
                {props.short ? connector.displayName.short : connector.displayName.long}
            </ActionMenu.Button>
            <ActionMenu.Overlay width={props.short ? 'auto' : 'medium'} align="end">
                <ActionList>
                    {connectorList.map((connector, i) => (
                        <ActionList.Item key={i} data-connector={i} onClick={selectConnector}>
                            <ActionList.LeadingVisual>{getConnectorIcon(connector)}</ActionList.LeadingVisual>
                            {props.short ? connector.displayName.short : connector.displayName.long}
                        </ActionList.Item>
                    ))}
                </ActionList>
            </ActionMenu.Overlay>
        </ActionMenu>
    );
};

const CommandListItems = (props: { connector: ConnectorInfo; canCycleOutput: boolean }) => {
    const [linkSharingIsOpen, openLinkSharing] = React.useState<boolean>(false);
    const [saveSqlIsOpen, openSaveSql] = React.useState<boolean>(false);
    return (
        <>
            <ActionList.Item>
                <ActionList.LeadingVisual>
                    <ArrowSwitchIcon />
                </ActionList.LeadingVisual>
                Cycle connectors
                <ActionList.TrailingVisual>Ctrl + N</ActionList.TrailingVisual>
            </ActionList.Item>
            <ActionList.Item disabled={!props.canCycleOutput}>
                <ActionList.LeadingVisual>
                    <ArrowSwitchIcon />
                </ActionList.LeadingVisual>
                Cycle output
                <ActionList.TrailingVisual>Ctrl + O</ActionList.TrailingVisual>
            </ActionList.Item>
            <ActionList.Divider />
            <ActionList.Item disabled={!props.connector.features.executeQueryAction}>
                <ActionList.LeadingVisual>
                    <PaperAirplaneIcon />
                </ActionList.LeadingVisual>
                Execute Query
                <ActionList.TrailingVisual>Ctrl + E</ActionList.TrailingVisual>
            </ActionList.Item>
            <ActionList.Item disabled={!props.connector.features.refreshSchemaAction}>
                <ActionList.LeadingVisual>
                    <SyncIcon />
                </ActionList.LeadingVisual>
                Refresh Schema
                <ActionList.TrailingVisual>Ctrl + R</ActionList.TrailingVisual>
            </ActionList.Item>
            <ActionList.Divider />
            <ActionList.Item onClick={() => openLinkSharing(s => !s)}>
                <ActionList.LeadingVisual>
                    <LinkIcon />
                </ActionList.LeadingVisual>
                <span>
                    Save Query as Link
                    <ScriptURLOverlay isOpen={linkSharingIsOpen} setIsOpen={openLinkSharing} />
                </span>
                <ActionList.TrailingVisual>Ctrl + L</ActionList.TrailingVisual>
            </ActionList.Item>
            <ActionList.Item onClick={() => openSaveSql(s => !s)}>
                <ActionList.LeadingVisual>
                    <DownloadIcon />
                </ActionList.LeadingVisual>
                <span>
                    Save Query as .sql
                    <ScriptFileSaveOverlay isOpen={saveSqlIsOpen} setIsOpen={openSaveSql} />
                </span>
                <ActionList.TrailingVisual>Ctrl + S</ActionList.TrailingVisual>
            </ActionList.Item>
            <ActionList.Item disabled={!props.connector.features.executeQueryAction}>
                <ActionList.LeadingVisual>
                    <DownloadIcon />
                </ActionList.LeadingVisual>
                Save Results as .arrow
                <ActionList.TrailingVisual>Ctrl + A</ActionList.TrailingVisual>
            </ActionList.Item>
        </>
    );
};

const GitHubIcon = () => (
    <svg width="20px" height="20px">
        <use xlinkHref={`${icons}#github`} />
    </svg>
);

const ProjectListItems = (props: {}) => (
    <>
        <ActionList.LinkItem href="https://github.com/ankoh/sqlynx" target="_blank">
            <ActionList.LeadingVisual>
                <GitHubIcon />
            </ActionList.LeadingVisual>
            Open-source project
        </ActionList.LinkItem>
        <ActionList.LinkItem href="https://github.com/ankoh/sqlynx/issues" target="_blank">
            <ActionList.LeadingVisual>
                <GitHubIcon />
            </ActionList.LeadingVisual>
            Report a bug
        </ActionList.LinkItem>
        <ActionList.LinkItem href="https://github.com/ankoh/sqlynx/discussions" target="_blank">
            <ActionList.LeadingVisual>
                <GitHubIcon />
            </ActionList.LeadingVisual>
            View discussions
        </ActionList.LinkItem>
    </>
);

enum TabKey {
    SchemaView = 0,
    QueryProgressView = 1,
    QueryResultView = 2,
}

interface TabState {
    enabledTabs: number;
}

export const EditorPage: React.FC<Props> = (props: Props) => {
    const scriptState = useScriptState();
    const connector = useSelectedConnector();
    const [selectedTab, selectTab] = React.useState<TabKey>(TabKey.SchemaView);
    const [sharingIsOpen, setSharingIsOpen] = React.useState<boolean>(false);

    // Determine selected tabs
    const tabState = React.useRef<TabState>({
        enabledTabs: 1,
    });
    let enabledTabs = 1;
    enabledTabs += +((scriptState.queryExecutionState?.startedAt ?? null) != null);
    enabledTabs += +(scriptState.queryExecutionResult != null);
    tabState.current.enabledTabs = enabledTabs;

    // Register keyboard events
    const keyHandlers = React.useMemo<KeyEventHandler[]>(
        () => [
            {
                key: 'o',
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
    const prevStatus = React.useRef<QueryExecutionTaskStatus | null>(null);
    React.useEffect(() => {
        const status = scriptState.queryExecutionState?.status ?? null;
        switch (status) {
            case null:
                break;
            case QueryExecutionTaskStatus.STARTED:
            case QueryExecutionTaskStatus.ACCEPTED:
            case QueryExecutionTaskStatus.RECEIVED_SCHEMA:
            case QueryExecutionTaskStatus.RECEIVED_FIRST_RESULT:
                if (prevStatus.current == null) {
                    selectTab(TabKey.QueryProgressView);
                }
                break;
            case QueryExecutionTaskStatus.FAILED:
                break;
            case QueryExecutionTaskStatus.SUCCEEDED:
                selectTab(TabKey.QueryResultView);
                break;
        }
        prevStatus.current = status;
    }, [scriptState.queryExecutionState?.status]);

    return (
        <div className={styles.page}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.page_title}>SQL Editor</div>
                </div>
                <div className={styles.header_action_container}>
                    <ConnectorSelection variant="default" short={true} />
                    <div>
                        <ButtonGroup className={primerBugFixes.button_group}>
                            <IconButton icon={PaperAirplaneIcon} aria-labelledby="create-github-issue" />
                            <IconButton icon={SyncIcon} aria-labelledby="visit-github-repository" />
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
                <TabCard
                    className={styles.output_card}
                    selectedTab={selectedTab}
                    selectTab={selectTab}
                    tabs={[
                        [TabKey.SchemaView, `${icons}#tables_connected`, true],
                        [TabKey.QueryProgressView, `${icons}#plan`, tabState.current.enabledTabs >= 2],
                        [TabKey.QueryResultView, `${icons}#table`, tabState.current.enabledTabs >= 3],
                    ]}
                    tabProps={{}}
                    tabRenderers={{
                        [TabKey.SchemaView]: _props => <SchemaGraph />,
                        [TabKey.QueryProgressView]: _props => <QueryProgress />,
                        [TabKey.QueryResultView]: _props => (
                            <DataTable data={scriptState.queryExecutionResult?.resultTable ?? null} />
                        ),
                    }}
                />
                <ScriptEditor className={styles.editor_card} />
                <div className={styles.action_sidebar}>
                    <ActionList key={0} className={styles.data_actions}>
                        <ConnectorSelection
                            className={styles.sidebar_connector_selection}
                            variant="invisible"
                            short={false}
                        />
                        <ActionList.Divider />
                        <CommandListItems connector={connector} canCycleOutput={enabledTabs > 1} />
                    </ActionList>
                    <ActionList key={1} className={styles.project_actions}>
                        <ProjectListItems />
                    </ActionList>
                </div>
            </div>
        </div>
    );
};
