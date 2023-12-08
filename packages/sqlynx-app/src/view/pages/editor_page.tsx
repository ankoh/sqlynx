import * as React from 'react';

import { ActionMenu, ActionList, ButtonGroup, IconButton } from '@primer/react';
import { NumberIcon } from '@primer/octicons-react';

import { useSQLynx } from '../../sqlynx_loader';
import { useAppConfig } from '../../state/app_config';
import { ScriptEditor } from '../editor/editor';
import { SchemaGraph } from '../../view/schema/schema_graph';
import { TabCard } from '../../view/tab_card';

import styles from './editor_page.module.css';
import icons from '../../../static/svg/symbols.generated.svg';

interface Props {}

const openInNewTab = (url: string) => {
    const newWindow = window.open(url, '_blank', 'noopener,noreferrer');
    if (newWindow) newWindow.opener = null;
};

const connections = [
    { icon: NumberIcon, name: 'No Database' },
    { icon: NumberIcon, name: 'Salesforce Data Cloud' },
    { icon: NumberIcon, name: 'Hyper Database' },
];

export const EditorPage: React.FC<Props> = (props: Props) => {
    const appConfig = useAppConfig();
    const backend = useSQLynx();
    // const version = React.useMemo(() => {
    //     if (!backend || backend.type != RESULT_OK) return 'unknown';
    //     return backend.value.getVersionText();
    // }, [backend]);

    const [selectedConnIdx, selectConn] = React.useState(1);
    const selectedConn = connections[selectedConnIdx];

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

    return (
        <div className={styles.page}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.page_title}>SQL Editor</div>
                </div>
                <div className={styles.header_right_container}>
                    <ButtonGroup>
                        <IconButton sx={{ width: '40px' }} icon={BugIcon} aria-labelledby="create-github-issue" />
                        <IconButton
                            sx={{ width: '40px' }}
                            icon={GitHubIcon}
                            aria-labelledby="visit-github-repository"
                        />
                    </ButtonGroup>
                </div>
            </div>
            <div className={styles.body_container}>
                <TabCard
                    selectedTab={1}
                    tabs={[[1, `${icons}#tables_connected`]]}
                    tabProps={{}}
                    tabRenderers={{
                        [1]: props => <SchemaGraph />,
                    }}
                />
                <div className={styles.editor_container}>
                    <div className={styles.editor_card}>
                        <ScriptEditor />
                    </div>
                </div>
                {appConfig.value?.features?.editorActions && (
                    <div className={styles.action_panel}>
                        <ActionMenu>
                            <ActionMenu.Button
                                variant="invisible"
                                aria-label="Select field type"
                                leadingVisual={selectedConn.icon}
                            >
                                {selectedConn.name}
                            </ActionMenu.Button>
                            <ActionMenu.Overlay width="medium">
                                <ActionList selectionVariant="single">
                                    {connections.map((type, index) => (
                                        <ActionList.Item
                                            key={index}
                                            selected={index === selectedConnIdx}
                                            onSelect={() => selectConn(index)}
                                        >
                                            <ActionList.LeadingVisual>
                                                <type.icon />
                                            </ActionList.LeadingVisual>
                                            {type.name}
                                        </ActionList.Item>
                                    ))}
                                </ActionList>
                            </ActionMenu.Overlay>
                        </ActionMenu>
                    </div>
                )}
            </div>
        </div>
    );
};
