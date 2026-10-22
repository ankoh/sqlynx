import * as React from 'react';
import icons from '@ankoh/dashql-svg-symbols';

import { VerticalTabs, VerticalTabVariant } from '../../../ui/foundations/vertical_tabs.js';
import { CONNECTOR_INFOS, ConnectorType, useConnectorList } from '../connector_info.js';
import { HyperConnectorSettings } from './hyper_connection_settings.js';
import { SalesforceConnectorSettings } from './salesforce_connection_settings.js';
import { TrinoConnectorSettings } from './trino_connection_settings.js';
import { useAttachedDatabaseById } from '../attached_database_registry.js';
import { ConnectionHealth, ConnectionStatus, SWITCH_CONNECTOR_TYPE } from '../attached_database_state.js';

interface Props {
    className?: string;
    databaseId: string | null;
    selectedConnectorType: ConnectorType;
    setSelectedConnectorType: (type: ConnectorType) => void;
    lockConnectorType?: boolean;
}

export const ConnectorConfigTabs: React.FC<Props> = (props: Props) => {
    const [conn, modifyConn] = useAttachedDatabaseById(props.databaseId);
    const availableConnectors = useConnectorList();
    const currentConnector = conn?.connectorInfo ?? null;
    const connectors = currentConnector && !availableConnectors.some(info => info.connectorType === currentConnector.connectorType)
        ? [currentConnector, ...availableConnectors]
        : availableConnectors;
    const connectorTypes = connectors.map(info => info.connectorType);

    // Check if connection is online or configured
    const isOnline = conn?.connectionHealth === ConnectionHealth.ONLINE;
    const isUnconfigured = conn?.connectionStatus === ConnectionStatus.NOT_STARTED && !conn?.active && conn?.paramsDraft == null;

    // Handle tab selection: switch the connection's type when unconfigured
    const handleSelectTab = React.useCallback((newType: ConnectorType) => {
        props.setSelectedConnectorType(newType);
        if (isUnconfigured && conn?.connectorInfo.connectorType !== newType) {
            modifyConn({ type: SWITCH_CONNECTOR_TYPE, value: newType });
        }
    }, [props.setSelectedConnectorType, isUnconfigured, conn?.connectorInfo.connectorType, modifyConn]);

    // Build tab props for all connector types
    const tabProps = {} as Record<ConnectorType, any>;
    const tabRenderers = {} as Record<ConnectorType, () => React.ReactElement>;

    connectorTypes.forEach(connectorType => {
        const info = CONNECTOR_INFOS[connectorType];
        const isCurrentConnection = conn?.connectorInfo.connectorType === connectorType;
        const isDisabled = (!isUnconfigured || isOnline || props.lockConnectorType) && !isCurrentConnection;

        tabProps[connectorType] = {
            tabId: connectorType,
            icon: `${icons}#${info.icons.outlines}`,
            iconActive: `${icons}#${info.icons.colored}`,
            labelShort: info.names.displayShort,
            ariaLabel: info.names.displayLong,
            disabled: isDisabled,
        };

        tabRenderers[connectorType] = () => {
            // Pass the session connection to the matching tab, or to all tabs when unconfigured
            // (since SWITCH_CONNECTOR_TYPE ensures the type matches the selected tab)
            const databaseId = (isCurrentConnection || isUnconfigured) ? props.databaseId : null;

            switch (connectorType) {
                case ConnectorType.TRINO:
                    return <TrinoConnectorSettings databaseId={databaseId} />;
                case ConnectorType.SALESFORCE_DATA_CLOUD:
                    return <SalesforceConnectorSettings databaseId={databaseId} />;
                case ConnectorType.HYPER:
                    return <HyperConnectorSettings databaseId={databaseId} />;
                default:
                    throw new Error(`unsupported connector type ${connectorType}`);
            }
        };
    });

    return (
        <VerticalTabs
            className={props.className}
            variant={VerticalTabVariant.Stacked}
            selectedTab={props.selectedConnectorType}
            selectTab={handleSelectTab}
            tabProps={tabProps}
            tabKeys={connectorTypes}
            tabRenderers={tabRenderers}
        />
    );
};
