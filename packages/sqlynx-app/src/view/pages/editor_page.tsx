import * as React from 'react';

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

export const EditorPage: React.FC<Props> = (props: Props) => {
    const appConfig = useAppConfig();
    const backend = useSQLynx();
    // const version = React.useMemo(() => {
    //     if (!backend || backend.type != RESULT_OK) return 'unknown';
    //     return backend.value.getVersionText();
    // }, [backend]);

    return (
        <div className={styles.page}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.page_title}>SQL Editor</div>
                </div>
                <div className={styles.header_right_container}>
                    {appConfig?.value?.features?.connections && (
                        <div className={styles.header_button_group}>
                            <div className={styles.header_button}>
                                <svg width="20px" height="20px">
                                    <use xlinkHref={`${icons}#link`} />
                                </svg>
                            </div>
                        </div>
                    )}
                    <div className={styles.header_button_group}>
                        <div
                            className={styles.header_button}
                            onClick={() => openInNewTab('https://github.com/ankoh/sqlynx/issues')}
                        >
                            <svg width="20px" height="20px">
                                <use xlinkHref={`${icons}#bug`} />
                            </svg>
                        </div>
                        <div
                            className={styles.header_button}
                            onClick={() => openInNewTab('https://github.com/ankoh/sqlynx')}
                        >
                            <svg width="20px" height="20px">
                                <use xlinkHref={`${icons}#github`} />
                            </svg>
                        </div>
                    </div>
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
            </div>
        </div>
    );
};
