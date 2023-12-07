import * as React from 'react';

import { SalesforceConnectorPanel } from '../../view/connector/salesforce_connector_panel';
import { HyperGrpcConnectorPanel } from '../connector/hyper_grpc_connector_panel';

import styles from './connections_page.module.css';

interface PageProps {}

export const ConnectionsPage: React.FC<PageProps> = (props: PageProps) => {
    return (
        <div className={styles.page}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.page_title}>Connections</div>
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
