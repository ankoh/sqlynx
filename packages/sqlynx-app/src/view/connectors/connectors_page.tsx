import * as React from 'react';

import { HyperGrpcConnectorSettings } from './hyper_grpc_connector_settings.js';
import { SalesforceConnectorSettings } from './salesforce_connector_settings.js';
import { Dispatch } from '../../utils/variant.js';
import { VerticalTabProps, VerticalTabRenderers, VerticalTabs, VerticalTabVariant } from '../foundations/vertical_tabs.js';
import { ConnectorType } from '../../connectors/connector_info.js';
import { PlatformCheck } from './platform_check.js';

import * as styles from './connectors_page.module.css';
import * as icons from '../../../static/svg/symbols.generated.svg';

type PageState = number | null;
type PageStateSetter = Dispatch<React.SetStateAction<PageState>>;
const PAGE_STATE_CTX = React.createContext<[PageState, PageStateSetter] | null>(null);

interface PageProps { }

interface ConnectorProps extends VerticalTabProps {
    connectorType: ConnectorType;
}

export const ConnectorsPage: React.FC<PageProps> = (_props: PageProps) => {
    const [selectedConnector, selectConnector] = React.useContext(PAGE_STATE_CTX)!;

    const connectors: Record<number, ConnectorProps> = React.useMemo(() => ({
        [ConnectorType.SALESFORCE_DATA_CLOUD]: {
            tabId: ConnectorType.SALESFORCE_DATA_CLOUD as number,
            labelShort: "Salesforce",
            labelLong: "Salesforce Data Cloud",
            icon: `${icons}#salesforce_outlines`,
            iconActive: `${icons}#salesforce_notext`,
            connectorType: ConnectorType.SALESFORCE_DATA_CLOUD,
        },
        [ConnectorType.HYPER_GRPC]: {
            tabId: ConnectorType.HYPER_GRPC as number,
            labelShort: "Hyper",
            labelLong: "Hyper Database",
            icon: `${icons}#hyper_outlines`,
            iconActive: `${icons}#hyper_nocolor`,
            connectorType: ConnectorType.HYPER_GRPC,
        },
    }), []);
    const connectorRenderers: VerticalTabRenderers<ConnectorProps> = React.useMemo(() => ({
        [ConnectorType.HYPER_GRPC as number]: (props: ConnectorProps) => <PlatformCheck connectorType={props.connectorType}><HyperGrpcConnectorSettings /></PlatformCheck>,
        [ConnectorType.SALESFORCE_DATA_CLOUD as number]: (props: ConnectorProps) => <PlatformCheck connectorType={props.connectorType}><SalesforceConnectorSettings /></PlatformCheck>,
//        [ConnectorType.SERVERLESS as number]: (props: ConnectorProps) => <PlatformCheck connectorType={props.connectorType}><ServerlessSettings /></PlatformCheck>,
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
                selectedTab={selectedConnector ?? (ConnectorType.HYPER_GRPC as number)}
                selectTab={selectConnector}
                tabKeys={[ConnectorType.HYPER_GRPC as number, ConnectorType.SALESFORCE_DATA_CLOUD as number]}
                tabProps={connectors}
                tabRenderers={connectorRenderers}
            />
        </div >
    );
};

interface ProviderProps { children: React.ReactElement };

export const ConnectorsPageStateProvider: React.FC<ProviderProps> = (props: ProviderProps) => {
    const state = React.useState<PageState>(null);
    return (
        <PAGE_STATE_CTX.Provider value={state}>
            {props.children}
        </PAGE_STATE_CTX.Provider>
    );
};
