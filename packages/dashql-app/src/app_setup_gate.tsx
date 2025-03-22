import * as pb from '@ankoh/dashql-protobuf';
import * as React from 'react';

import { ConnectionSetupPage } from './view/connection/connection_setup_page.js';
import { ConnectorInfo, getConnectorInfoForParams } from './connection/connector_info.js';
import { useServerlessWorkbookSetup } from './connection/serverless/serverless_session.js';
import { usePlatformEventListener } from './platform/event_listener_provider.js';
import { useSalesforceWorkbookSetup } from './connection/salesforce/salesforce_workbook.js';
import { useDemoWorkbookSetup } from './connection/demo/demo_workbook.js';
import { useHyperWorkbookSetup } from './connection/hyper/hyper_workbook.js';
import { useCurrentWorkbookSelector } from './workbook/current_workbook.js';
import { useLogger } from './platform/logger_provider.js';
import { useDynamicConnectionDispatch } from './connection/connection_registry.js';
import { useWorkbookRegistry } from './workbook/workbook_state_registry.js';
import { useTrinoWorkbookSetup } from './connection/trino/trino_session.js';
import { RESET } from './connection/connection_state.js';
import { isDebugBuild } from './globals.js';
import { SETUP_FILE, SETUP_WORKBOOK, SetupEventVariant } from './platform/event.js';

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

enum AppSetupDecision {
    UNDECIDED,
    SHOW_CONNECTION_SETUP,
    SETUP_DONE,
}

interface AppSetupArgs {
    connectionId: number;
    connectionParams: pb.dashql.connection.ConnectionParams;
    workbookId: number;
    workbookProto: pb.dashql.workbook.Workbook;
}

interface AppSetupState {
    decision: AppSetupDecision;
    args: AppSetupArgs | null;
}

export const AppSetupGate: React.FC<{ children: React.ReactElement }> = (props: { children: React.ReactElement }) => {
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

    const appEvents = usePlatformEventListener();
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
    const [state, setState] = React.useState<AppSetupState>(() => ({
        decision: AppSetupDecision.UNDECIDED,
        args: null,
    }));

    // Configure catalog and workbooks
    const runSetup = React.useCallback(async (data: SetupEventVariant) => {
        // Stop the default workbook switch after DashQL is ready
        abortDefaultWorkbookSwitch.current.abort("workbook_setup_event");
        // Await the setup of the static workbooks
        const defaultWorkbooks = await setupDefaultWorkbook;

        // Resolve workbook
        let catalogs: pb.dashql.file.FileCatalog[] = [];
        let workbooks: pb.dashql.workbook.Workbook[] = [];
        switch (data.type) {
            case SETUP_WORKBOOK:
                workbooks.push(data.value);
                break;
            case SETUP_FILE:
                catalogs = data.value.catalogs;
                workbooks = data.value.workbooks;
                break;
        }

        // Setup connection
        for (const catalogProto of catalogs) {
            // Get the connector info for the workbook setup protobuf
            const connectorInfo = catalogProto.connectionParams ? getConnectorInfoForParams(catalogProto.connectionParams) : null;
            if (connectorInfo == null) {
                logger.warn("failed to resolve the connector info from the parameters", {});
                continue;
            }

            // XXX
        }

        // Setup workbooks
        for (const workbookProto of workbooks) {
            // Get the connector info for the workbook setup protobuf
            const connectorInfo = workbookProto.connectionParams ? getConnectorInfoForParams(workbookProto.connectionParams) : null;
            if (connectorInfo == null) {
                logger.warn("failed to resolve the connector info from the parameters", {});
                return;
            }
            switch (workbookProto.connectionParams?.connection.case) {
                case "hyper": {
                    const workbook = workbookReg.workbookMap.get(defaultWorkbooks.hyper)!;
                    connDispatch(workbook.connectionId, { type: RESET, value: null });
                    selectCurrentWorkbook(defaultWorkbooks.hyper);
                    setState({
                        decision: AppSetupDecision.SHOW_CONNECTION_SETUP,
                        args: {
                            connectionId: workbook.connectionId,
                            connectionParams: workbookProto.connectionParams,
                            workbookId: defaultWorkbooks.hyper,
                            workbookProto: workbookProto,
                        },
                    });
                    break;
                }
                case "salesforce": {
                    const workbook = workbookReg.workbookMap.get(defaultWorkbooks.salesforce)!;
                    connDispatch(workbook.connectionId, { type: RESET, value: null });
                    selectCurrentWorkbook(defaultWorkbooks.salesforce);
                    setState({
                        decision: AppSetupDecision.SHOW_CONNECTION_SETUP,
                        args: {
                            connectionId: workbook.connectionId,
                            connectionParams: workbookProto.connectionParams,
                            workbookId: defaultWorkbooks.salesforce,
                            workbookProto: workbookProto,
                        },
                    });
                    break;
                }
                case "trino": {
                    const workbook = workbookReg.workbookMap.get(defaultWorkbooks.trino)!;
                    connDispatch(workbook.connectionId, { type: RESET, value: null });
                    selectCurrentWorkbook(defaultWorkbooks.trino);
                    setState({
                        decision: AppSetupDecision.SHOW_CONNECTION_SETUP,
                        args: {
                            connectionId: workbook.connectionId,
                            connectionParams: workbookProto.connectionParams,
                            workbookId: defaultWorkbooks.trino,
                            workbookProto: workbookProto,
                        },
                    });
                    return;
                }
                case "serverless": {
                    const workbook = workbookReg.workbookMap.get(defaultWorkbooks.serverless)!;
                    connDispatch(workbook.connectionId, { type: RESET, value: null });
                    selectCurrentWorkbook(defaultWorkbooks.serverless);
                    setState({
                        decision: AppSetupDecision.SETUP_DONE,
                        args: null,
                    });
                    return;
                }
                case "demo": {
                    const workbook = workbookReg.workbookMap.get(defaultWorkbooks.demo)!;
                    connDispatch(workbook.connectionId, { type: RESET, value: null });
                    selectCurrentWorkbook(defaultWorkbooks.demo);
                    setState({
                        decision: AppSetupDecision.SETUP_DONE,
                        args: null,
                    });
                    return;
                }
            }
        }
    }, []);

    // Register an event handler for setup events.
    // The user may either paste a deep link through the clipboard, or may run a setup through a deep link.
    React.useEffect(() => {
        // Subscribe to setup events
        appEvents.subscribeSetupEvents(runSetup);
        // Remove listener as soon as this component unmounts
        return () => {
            appEvents.unsubscribeSetupEvents(runSetup);
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
                decision: AppSetupDecision.SETUP_DONE,
                args: null,
            });
        };
        selectDefaultWorkbook();
    }, []);

    // Determine what we want to render
    let child: React.ReactElement = <div />;
    switch (state.decision) {
        case AppSetupDecision.UNDECIDED:
            break;
        case AppSetupDecision.SHOW_CONNECTION_SETUP: {
            const args = state.args!;
            child = <ConnectionSetupPage
                connectionId={args.connectionId}
                connectionParams={args.connectionParams}
                workbookProto={args.workbookProto}
                onDone={() => setState(s => ({ ...s, decision: AppSetupDecision.SETUP_DONE }))}
            />;
            break;
        }
        case AppSetupDecision.SETUP_DONE:
            child = props.children;
            break;
    }
    return (
        <DEFAULT_WORKBOOKS.Provider value={defaultWorkbooks}>
            {child}
        </DEFAULT_WORKBOOKS.Provider>
    );
};
