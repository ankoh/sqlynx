import * as React from 'react';

import * as styles from './connectors_page.module.css';
import { HyperGrpcConnectorSettings } from './hyper_grpc_connector_settings.js';
import { SalesforceConnectorSettings } from './salesforce_connector_settings.js';
import { Dispatch } from '../../utils/variant.js';

import { VerticalTabProps, VerticalTabRenderers, VerticalTabVariant, VerticalTabs } from '../../view/vertical_tabs.js';

import * as icons from '../../../static/svg/symbols.generated.svg';

type PageState = number | null;
type PageStateSetter = Dispatch<React.SetStateAction<PageState>>;
const PAGE_STATE_CTX = React.createContext<[PageState, PageStateSetter] | null>(null);

interface PageProps { }

interface ConnectorProps extends VerticalTabProps {

};

export const ConnectorsPage: React.FC<PageProps> = (_props: PageProps) => {
    const [selectedConnector, selectConnector] = React.useContext(PAGE_STATE_CTX)!;

    const connectors: ConnectorProps[] = React.useMemo(() => ([
        {
            tabId: 0,
            labelShort: "Hyper",
            labelLong: "Hyper Database",
            icon: `${icons}#hyper_outlines`,
            iconActive: `${icons}#hyper_nocolor`,
        },
        {
            tabId: 1,
            labelShort: "Salesforce",
            labelLong: "Salesforce Data Cloud",
            icon: `${icons}#salesforce_outlines`,
            iconActive: `${icons}#salesforce_notext`,
        },
        {
            tabId: 2,
            labelShort: "Brainstorm",
            labelLong: "Brainstorm Mode",
            icon: `${icons}#zap`,
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
                selectedTab={selectedConnector ?? 0}
                selectTab={selectConnector}
                tabs={connectors}
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
