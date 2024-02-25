import * as React from 'react';

import { ConnectorInfo, ConnectorType } from '../connectors/connector_info.js';

import * as icons from '../../static/svg/symbols.generated.svg';
import { PencilIcon, SquirrelIcon, TelescopeIcon, ZapIcon } from '@primer/octicons-react';

export const SalesforceIcon = () => (
    <svg width="20px" height="20px">
        <use xlinkHref={`${icons}#salesforce_notext`} />
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

export function getConnectorIcon(connector: ConnectorInfo): React.ReactElement {
    switch (connector.connectorType) {
        case ConnectorType.BRAINSTORM_MODE:
            return <ZapIcon />;
        case ConnectorType.SALESFORCE_DATA_CLOUD:
            return <SalesforceIcon />;
        case ConnectorType.HYPER_DATABASE:
            return <HyperIcon />;
    }
}
