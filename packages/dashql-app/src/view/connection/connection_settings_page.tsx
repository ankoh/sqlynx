import * as React from 'react';

import { HyperGrpcConnectorSettings } from './hyper_grpc_connector_settings.js';
import { SalesforceConnectorSettings } from './salesforce_connector_settings.js';
import { Dispatch } from '../../utils/variant.js';
import { VerticalTabProps, VerticalTabRenderers, VerticalTabs, VerticalTabVariant } from '../foundations/vertical_tabs.js';
import { CONNECTOR_INFOS, ConnectorType } from '../../connection/connector_info.js';
import { PlatformCheck } from './platform_check.js';
import { TrinoConnectorSettings } from './trino_connector_settings.js';
import { useCurrentWorkbookState } from '../../workbook/current_workbook.js';

import * as styles from './connection_settings_page.module.css';
import * as icons from '../../../static/svg/symbols.generated.svg';

type PageState = {
    workbook: null | {
        connectionId: number;
        connectorType: ConnectorType
    };
    focus: ConnectorType;
};
type PageStateSetter = Dispatch<React.SetStateAction<PageState>>;
const PAGE_STATE_CTX = React.createContext<[PageState, PageStateSetter] | null>(null);

interface PageProps { }

interface ConnectorProps extends VerticalTabProps {
    connectorType: ConnectorType;
}

const CONNECTOR_TABS: ConnectorType[] = [
    ConnectorType.HYPER_GRPC,
    ConnectorType.SALESFORCE_DATA_CLOUD,
    ConnectorType.TRINO
];

const CONNECTOR_RENDERERS: VerticalTabRenderers<ConnectorProps> = {
    [ConnectorType.HYPER_GRPC as number]: (props: ConnectorProps) => <PlatformCheck connectorType={props.connectorType}><HyperGrpcConnectorSettings /></PlatformCheck>,
    [ConnectorType.SALESFORCE_DATA_CLOUD as number]: (props: ConnectorProps) => <PlatformCheck connectorType={props.connectorType}><SalesforceConnectorSettings /></PlatformCheck>,
    [ConnectorType.TRINO as number]: (props: ConnectorProps) => <PlatformCheck connectorType={props.connectorType}><TrinoConnectorSettings /></PlatformCheck>,
};

export const ConnectionSettingsPage: React.FC<PageProps> = (_props: PageProps) => {
    const [pageState, updatePageState] = React.useContext(PAGE_STATE_CTX)!;
    const [workbook, _] = useCurrentWorkbookState();

    // If someone selects a Trino workbook, we should switch to the appropriate connector settings automatically.
    // Note that this suffers a bit right now from the fact that we only have one connection per connector.
    // Otherwise we could just always switch to the correct connection id.
    React.useEffect(() => {
        if (workbook != null && pageState.workbook?.connectionId != (workbook?.connectionId ?? null)) {
            const newFocus = workbook.connectorInfo.connectorType;
            if (newFocus != ConnectorType.SERVERLESS && newFocus != ConnectorType.DEMO) {
                updatePageState({
                    workbook: {
                        connectionId: workbook.connectionId,
                        connectorType: workbook.connectorInfo.connectorType,
                    },
                    focus: newFocus,
                });
            }
        }
    }, [workbook]);

    const connectors: Record<number, ConnectorProps> = React.useMemo(() => {
        let connectorProps: Record<number, ConnectorProps> = {};
        for (const tabType of CONNECTOR_TABS) {
            const connInfo = CONNECTOR_INFOS[tabType as number];
            connectorProps[tabType] = {
                tabId: tabType as number,
                labelShort: connInfo.displayName.short,
                labelLong: connInfo.displayName.long,
                icon: `${icons}#${connInfo.icons.outlines}`,
                iconActive: `${icons}#${connInfo.icons.uncolored}`,
                connectorType: tabType
            };
        }
        return connectorProps;
    }, []);

    const selectConnector = (tab: number) => {
        updatePageState(s => ({
            ...s,
            focus: tab as ConnectorType
        }));
    };

    return (
        <div className={styles.page}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.page_title}>Connection</div>
                </div>
            </div>
            <VerticalTabs
                variant={VerticalTabVariant.Wide}
                selectedTab={pageState.focus}
                selectTab={selectConnector}
                tabKeys={CONNECTOR_TABS}
                tabProps={connectors}
                tabRenderers={CONNECTOR_RENDERERS}
            />
        </div >
    );
};

interface ProviderProps { children: React.ReactElement };

export const ConnectionSettingsPageStateProvider: React.FC<ProviderProps> = (props: ProviderProps) => {
    const state = React.useState<PageState>({
        workbook: null,
        focus: ConnectorType.HYPER_GRPC
    });
    return (
        <PAGE_STATE_CTX.Provider value={state}>
            {props.children}
        </PAGE_STATE_CTX.Provider>
    );
};
