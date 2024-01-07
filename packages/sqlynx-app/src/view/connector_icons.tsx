import * as React from 'react';

import { Connector, ConnectorType } from '../connectors/connector';

import icons from '../../static/svg/symbols.generated.svg';

const SalesforceIcon = () => (
    <svg width="20px" height="20px">
        <use xlinkHref={`${icons}#salesforce-notext`} />
    </svg>
);
const CloudOfflineIcon = () => (
    <svg width="20px" height="20px">
        <use xlinkHref={`${icons}#cloud_offline`} />
    </svg>
);
const HyperIcon = () => (
    <svg width="20px" height="20px">
        <use xlinkHref={`${icons}#hyper`} />
    </svg>
);

export function getConnectorIcon(connector: Connector): React.ReactElement {
    switch (connector.connectorType) {
        case ConnectorType.LOCAL_SCRIPT:
            return <CloudOfflineIcon />;
        case ConnectorType.SALESFORCE_DATA_CLOUD_CONNECTOR:
            return <SalesforceIcon />;
        case ConnectorType.HYPER_DATABASE:
            return <HyperIcon />;
    }
}
