import * as React from 'react';

import { SalesforceConnectorPanel } from './salesforce_connector_panel.js';
import { HyperGrpcConnectorPanel } from './hyper_grpc_connector_panel.js';
import { ConnectorProps, ConnectorRenderers, ConnectorSettingsNav } from './connector_settings_nav.js';

interface PageProps { }

export const ConnectorSettings: React.FC<PageProps> = (_props: PageProps) => {
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
        [0]: (_props: {}) => <div><SalesforceConnectorPanel /></div>,
        [1]: (_props: {}) => <div><HyperGrpcConnectorPanel /></div>,
    }), []);

    return (
        <ConnectorSettingsNav
            connectors={connectors}
            connectorRenderers={connectorRenderers}
            selectConnector={selectConnector}
            selectedConnector={selectedConnector}
        />
    );
};
