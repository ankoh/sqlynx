import * as React from 'react';

import { ConnectorInfo, ConnectorType } from '../connectors/connector_info.js';

import * as icons from '../../static/svg/symbols.generated.svg';

export const SalesforceIcon = () => (
    <svg width="20px" height="20px">
        <use xlinkHref={`${icons}#salesforce_notext`} />
    </svg>
);
const BrainstormIcon = () => (
    <svg width="20px" height="20px">
        <use xlinkHref={`${icons}#folder`} />
    </svg>
);
const HyperIcon = () => (
    <svg width="20px" height="20px">
        <use xlinkHref={`${icons}#hyper`} />
    </svg>
);

export function getConnectorIcon(connector: ConnectorInfo): React.ReactElement {
    switch (connector.connectorType) {
        case ConnectorType.FILES:
            return <BrainstormIcon />;
        case ConnectorType.SALESFORCE_DATA_CLOUD:
            return <SalesforceIcon />;
        case ConnectorType.HYPER_GRPC:
            return <HyperIcon />;
    }
}
