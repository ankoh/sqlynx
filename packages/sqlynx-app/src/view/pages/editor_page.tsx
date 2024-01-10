import * as React from 'react';
import * as arrow from 'apache-arrow';

import { ActionList, IconButton, ButtonGroup, ActionMenu } from '@primer/react';
import { SyncIcon, PaperAirplaneIcon, LinkIcon, DownloadIcon, ThreeBarsIcon } from '@primer/octicons-react';

import {
    SELECT_CONNECTOR,
    useSelectedConnector,
    useConnectorList,
    useConnectorSelection,
} from '../../connectors/connector_selection';
import { ConnectorInfo, ConnectorType } from '../../connectors/connector_info';
import { useAppConfig } from '../../app_config';
import { ScriptEditor } from '../editor/editor';
import { SchemaGraph } from '../../view/schema/schema_graph';
import { QueryProgress } from '../../view/progress/query_progress';
import { DataTable } from '../../view/table/data_table';
import { TabCard } from '../../view/tab_card';
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

const CommandListItems = (props: { connector: ConnectorInfo }) => {
    const [sharingIsOpen, setSharingIsOpen] = React.useState<boolean>(false);
    return (
        <>
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
            <ActionList.Item onClick={() => setSharingIsOpen(s => !s)}>
                <ActionList.LeadingVisual>
                    <LinkIcon />
                </ActionList.LeadingVisual>
                <span>
                    Save Query as Link
                    <ScriptURLOverlay isOpen={sharingIsOpen} setIsOpen={setSharingIsOpen} />
                </span>
                <ActionList.TrailingVisual>Ctrl + L</ActionList.TrailingVisual>
            </ActionList.Item>
            <ActionList.Item>
                <ActionList.LeadingVisual>
                    <DownloadIcon />
                </ActionList.LeadingVisual>
                Save Query as .sql
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

export const EditorPage: React.FC<Props> = (props: Props) => {
    const appConfig = useAppConfig();
    const connector = useSelectedConnector();
    const [selectedTab, selectTab] = React.useState<number>(1);

    const columnA = Int32Array.from({ length: 1000 }, () => Number((Math.random() * 1000).toFixed(0)));
    const columnB = Int32Array.from({ length: 1000 }, () => Number((Math.random() * 1000).toFixed(0)));
    const columnC = Int32Array.from({ length: 1000 }, () => Number((Math.random() * 1000).toFixed(0)));
    const table = arrow.tableFromArrays({
        A: columnA,
        B: columnB,
        C: columnC,
    });
    const [sharingIsOpen, setSharingIsOpen] = React.useState<boolean>(false);

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
                        [1, `${icons}#tables_connected`, true],
                        [2, `${icons}#plan`, false],
                        [3, `${icons}#table`, false],
                    ]}
                    tabProps={{}}
                    tabRenderers={{
                        [1]: props => <SchemaGraph />,
                        [2]: props => <QueryProgress />,
                        [3]: props => <DataTable data={table} />,
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
                        <CommandListItems connector={connector} />
                    </ActionList>
                    <ActionList key={1} className={styles.project_actions}>
                        <ProjectListItems />
                    </ActionList>
                </div>
            </div>
        </div>
    );
};
