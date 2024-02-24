import * as React from 'react';

import styles from './connectors_page.module.css';
import { HyperGrpcConnectorSettings } from './hyper_grpc_connector_settings.js';
import { SalesforceConnectorSettings } from './salesforce_connector_settings.js';

import { VerticalTabProps, VerticalTabRenderers, VerticalTabVariant, VerticalTabs } from '../../view/vertical_tabs.js';

import * as icons from '../../../static/svg/symbols.generated.svg';

interface PageProps { }

interface ConnectorProps extends VerticalTabProps {

};

export const ConnectorsPage: React.FC<PageProps> = (_props: PageProps) => {
    const [selectedConnector, selectConnector] = React.useState(0);

    const connectors: ConnectorProps[] = React.useMemo(() => ([
        {
            tabId: 0,
            labelShort: "Hyper",
            labelLong: "Hyper Database",
            icon: `${icons}#hyper_outlines`,
        },
        {
            tabId: 1,
            labelShort: "Salesforce",
            labelLong: "Salesforce Data Cloud",
            icon: `${icons}#salesforce_outlines`,
        },
        {
            tabId: 2,
            labelShort: "Local",
            labelLong: "Local Scripts",
            icon: `${icons}#cloud_offline`,
        }
    ]), []);
    const connectorRenderers: VerticalTabRenderers = React.useMemo(() => ({
        [0]: (_props: ConnectorProps) => <HyperGrpcConnectorSettings />,
        [1]: (_props: ConnectorProps) => <SalesforceConnectorSettings />,
    }), []);

    return (
        <div className={styles.page}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.page_title}>Connectors</div>
                </div>
            </div>
            <VerticalTabs
                variant={VerticalTabVariant.Wide}
                selectedTab={selectedConnector}
                selectTab={selectConnector}
                tabs={connectors}
                tabRenderers={connectorRenderers}
            />
        </div >
    );
};
