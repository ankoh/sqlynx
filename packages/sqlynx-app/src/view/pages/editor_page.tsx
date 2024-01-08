import * as React from 'react';
import * as arrow from 'apache-arrow';

import { ActionList, Button, IconButton, ButtonGroup, AnchoredOverlay, Box } from '@primer/react';
import {
    TriangleDownIcon,
    SyncIcon,
    PaperAirplaneIcon,
    LinkIcon,
    DownloadIcon,
    ThreeBarsIcon,
} from '@primer/octicons-react';

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
import { getConnectorIcon } from '../connector_icons';

import styles from './editor_page.module.css';
import icons from '../../../static/svg/symbols.generated.svg';

interface Props {}

const BugIcon = () => (
    <svg width="20px" height="20px">
        <use xlinkHref={`${icons}#bug`} />
    </svg>
);
const GitHubIcon = () => (
    <svg width="20px" height="20px">
        <use xlinkHref={`${icons}#github`} />
    </svg>
);

const ActionsPanel = (props: { connector: ConnectorInfo }) => {
    const connectorList = useConnectorList();
    const connectorSelection = useConnectorSelection();
    const connectorListAnchor = React.useRef(null);
    const [selectorIsOpen, setSelectorIsOpen] = React.useState<boolean>(false);

    const selectConnector = React.useCallback((e: React.MouseEvent<HTMLLIElement, MouseEvent>) => {
        e.stopPropagation();
        const target = e.currentTarget as HTMLLIElement;
        const connectorType = Number.parseInt(target.dataset.connector ?? '0')! as ConnectorType;
        setSelectorIsOpen(false);
        connectorSelection({
            type: SELECT_CONNECTOR,
            value: connectorType,
        });
    }, []);

    return (
        <div className={styles.action_container}>
            <ActionList key={0} className={styles.data_actions}>
                <ActionList.Item
                    onClick={() => {
                        setSelectorIsOpen(true);
                    }}
                >
                    <ActionList.LeadingVisual>{getConnectorIcon(props.connector)}</ActionList.LeadingVisual>
                    {props.connector.displayName}
                    <ActionList.TrailingVisual>
                        <AnchoredOverlay
                            renderAnchor={anchorProps => (
                                <div ref={connectorListAnchor}>
                                    <TriangleDownIcon />
                                </div>
                            )}
                            open={selectorIsOpen}
                            onClose={() => setSelectorIsOpen(false)}
                            anchorRef={connectorListAnchor}
                            align="end"
                        >
                            <Box sx={{ width: '240px' }}>
                                <ActionList>
                                    {connectorList.map((connector, i) => (
                                        <ActionList.Item key={i} data-connector={i} onClick={selectConnector}>
                                            <ActionList.LeadingVisual>
                                                {getConnectorIcon(connector)}
                                            </ActionList.LeadingVisual>
                                            {connector.displayName}
                                        </ActionList.Item>
                                    ))}
                                </ActionList>
                            </Box>
                        </AnchoredOverlay>
                    </ActionList.TrailingVisual>
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
                <ActionList.Item>
                    <ActionList.LeadingVisual>
                        <LinkIcon />
                    </ActionList.LeadingVisual>
                    Save Query as Link
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
            </ActionList>
            <ActionList key={1} className={styles.project_actions}>
                <ActionList.Item>
                    <ActionList.LeadingVisual>
                        <GitHubIcon />
                    </ActionList.LeadingVisual>
                    Open-source project
                </ActionList.Item>
                <ActionList.Item>
                    <ActionList.LeadingVisual>
                        <GitHubIcon />
                    </ActionList.LeadingVisual>
                    Report a bug
                </ActionList.Item>
                <ActionList.Item>
                    <ActionList.LeadingVisual>
                        <GitHubIcon />
                    </ActionList.LeadingVisual>
                    View discussions
                </ActionList.Item>
            </ActionList>
        </div>
    );
};

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

    return (
        <div className={styles.page}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.page_title}>SQL Editor</div>
                </div>
                <div className={styles.header_action_container}>
                    <Button variant="invisible" className={styles.header_action_connector}>
                        {connector.displayName}
                    </Button>
                    <ButtonGroup>
                        <IconButton icon={PaperAirplaneIcon} aria-labelledby="create-github-issue" />
                        <IconButton icon={SyncIcon} aria-labelledby="visit-github-repository" />
                        <IconButton icon={LinkIcon} aria-labelledby="visit-github-repository" />
                    </ButtonGroup>
                    <ButtonGroup>
                        <IconButton icon={ThreeBarsIcon} aria-labelledby="visit-github-repository" />
                    </ButtonGroup>
                </div>
            </div>
            <div className={styles.body_container}>
                <TabCard
                    className={styles.output_card}
                    selectedTab={selectedTab}
                    selectTab={selectTab}
                    tabs={[
                        [1, `${icons}#tables_connected`],
                        [2, `${icons}#log`],
                        [3, `${icons}#table`],
                    ]}
                    tabProps={{}}
                    tabRenderers={{
                        [1]: props => <SchemaGraph />,
                        [2]: props => <QueryProgress />,
                        [3]: props => <DataTable data={table} />,
                    }}
                />
                <ScriptEditor className={styles.editor_card} />
                <ActionsPanel connector={connector} />
            </div>
        </div>
    );
};
