import * as React from 'react';

import { SalesforceConnectorSettings } from './salesforce_connector_settings.js';
import { HyperGrpcConnectorSettings } from './hyper_grpc_connector_settings.js';
import { ConnectorProps, ConnectorRenderers, ConnectorSettingsNav } from './connector_settings_nav.js';

interface PageProps { }

export const ConnectorSettings: React.FC<PageProps> = (_props: PageProps) => {
    const [selectedConnector, selectConnector] = React.useState(0);

    const connectors: ConnectorProps[] = React.useMemo(() => ([
        {
            id: 0,
            label: "Salesforce Data Cloud"
        },
        {
            id: 1,
            label: "Hyper Database"
        },
        {
            id: 2,
            label: "Local Scripts"
        }
    ]), []);
    const connectorRenderers: ConnectorRenderers = React.useMemo(() => ({
        [0]: (_props: {}) => <div><SalesforceConnectorSettings /></div>,
        [1]: (_props: {}) => <div><HyperGrpcConnectorSettings /></div>,
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
