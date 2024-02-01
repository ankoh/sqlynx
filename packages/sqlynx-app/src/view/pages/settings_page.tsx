import * as React from 'react';

import { SalesforceConnectorPanel } from '../connector/salesforce_connector_panel';
import { HyperGrpcConnectorPanel } from '../connector/hyper_grpc_connector_panel';

import styles from './settings_page.module.css';

interface PageProps {}

export const SettingsPage: React.FC<PageProps> = (props: PageProps) => {
    return (
        <div className={styles.page}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.page_title}>Settings</div>
                </div>
            </div>
            <div className={styles.body_container}>
                <div className={styles.card_container}>
                    <SalesforceConnectorPanel />
                </div>
                <div className={styles.card_container}>
                    <HyperGrpcConnectorPanel />
                </div>
            </div>
        </div>
    );
};
