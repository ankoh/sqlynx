import * as React from 'react';

import * as classNames from 'classnames';
import { SalesforceConnectorPanel } from './salesforce_connector_panel.js';
import { HyperGrpcConnectorPanel } from './hyper_grpc_connector_panel.js';

import styles from './settings_page.module.css';

interface PageProps { }

export const SettingsPage: React.FC<PageProps> = (_props: PageProps) => {
    return (
        <div className={styles.page}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.page_title}>Settings</div>
                </div>
            </div>
            <div className={styles.body_container}>
                <div className={styles.subpage_list_background} />
                <div className={styles.section_list_container}>
                    <div className={classNames.default(styles.section_list_entry, styles.section_list_entry_active)}>
                        Connnectors
                    </div>
                    <div className={styles.section_list_entry}>Configuration</div>
                    <div className={styles.section_list_entry}>About</div>
                </div>
                <div className={styles.connector_list_container}>
                    <div className={styles.connector_list_entry}>Hyper Database</div>
                    <div className={styles.connector_list_entry}>Salesforce Data Cloud</div>
                    <div className={styles.connector_list_entry}>Local Scripts</div>
                </div>
                <div className={styles.connector_details_container}>
                    <div className={styles.card_container}>
                        <SalesforceConnectorPanel />
                    </div>
                    <div className={styles.card_container}>
                        <HyperGrpcConnectorPanel />
                    </div>
                </div>
            </div>
        </div>
    );
};
