import * as React from 'react';

import styles from './connectors_page.module.css';
import { ConnectorProps, ConnectorRenderers, ConnectorSettingsNav } from './connector_settings_nav.js';
import { HyperGrpcConnectorSettings } from './hyper_grpc_connector_settings.js';
import { SalesforceConnectorSettings } from './salesforce_connector_settings.js';

interface PageProps { }

export const ConnectorsPage: React.FC<PageProps> = (_props: PageProps) => {
    const [selectedConnector, selectConnector] = React.useState(0);

    const connectors: ConnectorProps[] = React.useMemo(() => ([
        {
            id: 0,
            label: "Hyper Database"
        },
        {
            id: 1,
            label: "Salesforce Data Cloud"
        },
        {
            id: 2,
            label: "Local Scripts"
        }
    ]), []);
    const connectorRenderers: ConnectorRenderers = React.useMemo(() => ({
        [0]: (_props: {}) => <div><HyperGrpcConnectorSettings /></div>,
        [1]: (_props: {}) => <div><SalesforceConnectorSettings /></div>,
    }), []);

    return (
        <div className={styles.page}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.page_title}>Connectors</div>
                </div>
            </div>
            <ConnectorSettingsNav
                connectors={connectors}
                connectorRenderers={connectorRenderers}
                selectConnector={selectConnector}
                selectedConnector={selectedConnector}
            />
        </div >
    );
};
