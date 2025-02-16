import * as proto from '@ankoh/sqlynx-protobuf';
import * as React from 'react';

import { WorkbookSetupPage } from './workbook_setup_page.js';
import { ConnectorInfo, getConnectorInfoForParams } from '../connection/connector_info.js';
import { useServerlessWorkbookSetup } from '../connection/serverless/serverless_session.js';
import { useAppEventListener } from '../platform/event_listener_provider.js';
import { useSalesforceWorkbookSetup } from '../connection/salesforce/salesforce_workbook.js';
import { useDemoWorkbookSetup } from '../connection/demo/demo_workbook.js';
import { useHyperWorkbookSetup } from '../connection/hyper/hyper_workbook.js';
import { useCurrentWorkbookSelector } from './current_workbook.js';
import { useLogger } from '../platform/logger_provider.js';
import { useDynamicConnectionDispatch } from '../connection/connection_registry.js';
import { useWorkbookRegistry } from './workbook_state_registry.js';
import { useTrinoWorkbookSetup } from '../connection/trino/trino_session.js';
import { RESET } from '../connection/connection_state.js';
import { isDebugBuild } from '../globals.js';

/// For now, we just set up one workbook per connector.
/// Our abstractions would allow for a more dynamic workbook management, but we don't have the UI for that.
interface DefaultWorkbooks {
    salesforce: number;
    hyper: number;
    serverless: number;
    trino: number;
    demo: number;
}
const DEFAULT_WORKBOOKS = React.createContext<DefaultWorkbooks | null>(null);
export const useDefaultWorkbooks = () => React.useContext(DEFAULT_WORKBOOKS);

enum WorkbookSetupDecision {
    UNDECIDED,
    SKIP_SETUP_PAGE,
    SHOW_SETUP_PAGE,
}

interface WorkbookSetupArgs {
    workbookId: number;
    connector: ConnectorInfo;
    setupProto: proto.sqlynx_workbook.pb.Workbook;
}

interface WorkbookSetupState {
    decision: WorkbookSetupDecision;
    args: WorkbookSetupArgs | null;
}

export const WorkbookSetup: React.FC<{ children: React.ReactElement }> = (props: { children: React.ReactElement }) => {
    const logger = useLogger();

    const setupServerlessWorkbook = useServerlessWorkbookSetup();
    const setupHyperWorkbook = useHyperWorkbookSetup();
    const setupSalesforceWorkbook = useSalesforceWorkbookSetup();
    const setupDemoWorkbook = useDemoWorkbookSetup();
    const setupTrinoWorkbook = useTrinoWorkbookSetup();

    const selectCurrentWorkbook = useCurrentWorkbookSelector();
    const [defaultWorkbooks, setDefaultWorkbooks] = React.useState<DefaultWorkbooks | null>(null);
    const workbookReg = useWorkbookRegistry();
    const [_connReg, connDispatch] = useDynamicConnectionDispatch();

    const appEvents = useAppEventListener();
    const abortDefaultWorkbookSwitch = React.useRef(new AbortController());

    const setupDefaultWorkbook = React.useMemo(async () => {
        const [sf, hyper, serverless, demo, trino] = await Promise.all([
            setupSalesforceWorkbook(),
            setupHyperWorkbook(),
            setupServerlessWorkbook(),
            setupDemoWorkbook(),
            setupTrinoWorkbook(),
        ]);
        const defaultWorkbooks: DefaultWorkbooks = {
            salesforce: sf,
            hyper: hyper,
            serverless: serverless,
            trino: trino,
            demo: demo,
        };
        setDefaultWorkbooks(defaultWorkbooks);
        return defaultWorkbooks;
    }, []);

    // State to decide about workbook setup strategy
    const [state, setState] = React.useState<WorkbookSetupState>(() => ({
        decision: WorkbookSetupDecision.UNDECIDED,
        args: null,
    }));

    // Register an event handler for setup events.
    // The user may either paste a deep link through the clipboard, or may run a setup through a deep link.
    React.useEffect(() => {
        // Create a subscriber
        const subscriber = async (data: proto.sqlynx_workbook.pb.Workbook) => {
            // Stop the default workbook switch after SQLynx is ready
            abortDefaultWorkbookSwitch.current.abort("workbook_setup_event");
            // Await the setup of the static workbooks
            const defaultWorkbooks = await setupDefaultWorkbook;
            // Get the connector info for the workbook setup protobuf
            const connectorInfo = data.connectorParams ? getConnectorInfoForParams(data.connectorParams) : null;
            if (connectorInfo == null) {
                logger.warn("failed to resolve the connector info from the parameters", {});
                return;
            }
            switch (data.connectorParams?.connector.case) {
                case "hyper": {
                    const workbook = workbookReg.workbookMap.get(defaultWorkbooks.hyper)!;
                    connDispatch(workbook.connectionId, { type: RESET, value: null });
                    selectCurrentWorkbook(defaultWorkbooks.hyper);
                    setState({
                        decision: WorkbookSetupDecision.SHOW_SETUP_PAGE,
                        args: {
                            workbookId: defaultWorkbooks.hyper,
                            connector: connectorInfo,
                            setupProto: data,
                        },
                    });
                    break;
                }
                case "salesforce": {
                    const workbook = workbookReg.workbookMap.get(defaultWorkbooks.salesforce)!;
                    connDispatch(workbook.connectionId, { type: RESET, value: null });
                    selectCurrentWorkbook(defaultWorkbooks.salesforce);
                    setState({
                        decision: WorkbookSetupDecision.SHOW_SETUP_PAGE,
                        args: {
                            workbookId: defaultWorkbooks.salesforce,
                            connector: connectorInfo,
                            setupProto: data,
                        },
                    });
                    break;
                }
                case "trino": {
                    const workbook = workbookReg.workbookMap.get(defaultWorkbooks.trino)!;
                    connDispatch(workbook.connectionId, { type: RESET, value: null });
                    selectCurrentWorkbook(defaultWorkbooks.trino);
                    setState({
                        decision: WorkbookSetupDecision.SHOW_SETUP_PAGE,
                        args: {
                            workbookId: defaultWorkbooks.trino,
                            connector: connectorInfo,
                            setupProto: data,
                        },
                    });
                    return;
                }
                case "serverless": {
                    const workbook = workbookReg.workbookMap.get(defaultWorkbooks.serverless)!;
                    connDispatch(workbook.connectionId, { type: RESET, value: null });
                    selectCurrentWorkbook(defaultWorkbooks.serverless);
                    setState({
                        decision: WorkbookSetupDecision.SKIP_SETUP_PAGE,
                        args: null,
                    });
                    return;
                }
                case "demo": {
                    const workbook = workbookReg.workbookMap.get(defaultWorkbooks.demo)!;
                    connDispatch(workbook.connectionId, { type: RESET, value: null });
                    selectCurrentWorkbook(defaultWorkbooks.demo);
                    setState({
                        decision: WorkbookSetupDecision.SKIP_SETUP_PAGE,
                        args: null,
                    });
                    return;
                }
            }
        };

        // Subscribe to setup events
        appEvents.subscribeWorkbookSetupEvents(subscriber);
        // Remove listener as soon as this component unmounts
        return () => {
            appEvents.unsubscribeWorkbookSetupEvents(subscriber);
        };
    }, [appEvents]);

    // Effect to switch to default workbook after setup
    React.useEffect(() => {
        const selectDefaultWorkbook = async () => {
            // Await the setup of the static workbooks
            const defaultWorkbooks = await setupDefaultWorkbook;
            // We might have received a workbook setup link in the meantime.
            // In that case, don't default-select the serverless workbook
            if (abortDefaultWorkbookSwitch.current.signal.aborted) {
                return;
            }
            // Be extra careful not to override a selected workbook
            const d = isDebugBuild() ? defaultWorkbooks.demo : defaultWorkbooks.serverless;
            selectCurrentWorkbook(s => (s == null) ? d : s);
            // Skip the setup
            setState({
                decision: WorkbookSetupDecision.SKIP_SETUP_PAGE,
                args: null,
            });
        };
        selectDefaultWorkbook();
    }, []);

    // Determine what we want to render
    let child: React.ReactElement = <div />;
    switch (state.decision) {
        case WorkbookSetupDecision.UNDECIDED:
            break;
        case WorkbookSetupDecision.SKIP_SETUP_PAGE:
            child = props.children;
            break;
        case WorkbookSetupDecision.SHOW_SETUP_PAGE: {
            const args = state.args!;
            child = <WorkbookSetupPage
                workbookId={args.workbookId}
                connector={args.connector}
                setupProto={args.setupProto}
                onDone={() => setState(s => ({ ...s, decision: WorkbookSetupDecision.SKIP_SETUP_PAGE }))}
            />;
            break;
        }
    }
    return (
        <DEFAULT_WORKBOOKS.Provider value={defaultWorkbooks}>
            {child}
        </DEFAULT_WORKBOOKS.Provider>
    );
};
