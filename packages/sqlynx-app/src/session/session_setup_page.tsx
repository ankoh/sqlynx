import * as React from 'react';

import * as LZString from 'lz-string';
import { Button, IconButton } from '@primer/react';

import {
    CONNECTOR_INFOS,
    ConnectorAuthCheck,
    ConnectorInfo,
    ConnectorType,
    HYPER_DATABASE,
    BRAINSTORM_MODE,
    SALESFORCE_DATA_CLOUD,
    requiresSwitchingToNative,
} from '../connectors/connector_info.js';
import { ConnectorSetupParamVariant, checkSalesforceAuthSetup, readConnectorParamsFromURL } from '../connectors/connector_url_params.js';
import { useSalesforceConnectionId } from '../connectors/salesforce_auth_state.js';
import { useActiveSessionState, useActiveSessionStateDispatch } from './session_state_provider.js';
import { REPLACE_SCRIPT_CONTENT } from './session_state_reducer.js';
import { SQLYNX_VERSION } from '../globals.js';
import { ScriptKey } from './session_state.js';
import { TextField } from '../view/text_field.js';
import { LogViewerInPortal } from '../view/log_viewer.js';
import { useLogger } from '../platform/logger_provider.js';

import * as page_styles from '../view/banner_page.module.css';
import * as symbols from '../../static/svg/symbols.generated.svg';
import { useConnectionState } from '../connectors/connection_manager.js';
import { SalesforceConnectorState } from '../connectors/connection_state.js';

interface Props {
    searchParams: URLSearchParams;
    onDone: () => void;
}

interface State {
    scriptText: string | null;
    schemaText: string | null;
    connectorParams: ConnectorSetupParamVariant | null;
}

const ConnectorParamsSection: React.FC<{ params: ConnectorSetupParamVariant }> = (props: { params: ConnectorSetupParamVariant }) => {
    switch (props.params.type) {
        case SALESFORCE_DATA_CLOUD: {
            return (
                <div className={page_styles.card_section}>
                    <div className={page_styles.section_entries}>
                        <TextField
                            name="Salesforce Instance URL"
                            value={props.params.value.instanceUrl ?? ""}
                            readOnly={true}
                            disabled={true}
                            leadingVisual={() => <div>URL</div>}
                        />
                        <TextField
                            name="Connected App"
                            value={props.params.value.appConsumerKey ?? ""}
                            readOnly={true}
                            disabled={true}
                            leadingVisual={() => <div>ID</div>}
                        />
                    </div>
                </div>
            );
        }
        default: {
            return <div />;
        }
    }
};

export const SessionSetupPage: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const [logsAreOpen, setLogsAreOpen] = React.useState<boolean>(false);
    const connectionId = useSalesforceConnectionId();
    const [connection, _setConnection] = useConnectionState<SalesforceConnectorState>(connectionId);

    const selectedScript = useActiveSessionState();
    const selectedScriptDispatch = useActiveSessionStateDispatch();
    const [state, setState] = React.useState<State | null>(null);

    // Parse setup parameters and make them available through a state.
    React.useEffect(() => {
        // Read the inline scripts
        const scriptParam = props.searchParams.get('script');
        const schemaParam = props.searchParams.get('schema');
        let scriptText = null;
        let schemaText = null;
        if (scriptParam !== null) {
            scriptText = LZString.decompressFromBase64(scriptParam);
        }
        if (schemaParam !== null) {
            schemaText = LZString.decompressFromBase64(schemaParam);
        }
        // Unpack the URL parameters
        const connectorParams = readConnectorParamsFromURL(props.searchParams);
        setState({
            scriptText,
            schemaText,
            connectorParams,
        });
    }, []);

    // Resolve the connector info
    let connectorInfo: ConnectorInfo | null = null;
    let connectorAuthCheck: ConnectorAuthCheck | null = null;
    switch (state?.connectorParams?.type) {
        case SALESFORCE_DATA_CLOUD:
            connectorInfo = CONNECTOR_INFOS[ConnectorType.SALESFORCE_DATA_CLOUD as number];
            connectorAuthCheck = checkSalesforceAuthSetup(connection, state.connectorParams.value);
            break;
        case HYPER_DATABASE:
            connectorInfo = CONNECTOR_INFOS[ConnectorType.HYPER_DATABASE as number];
            break;
        case BRAINSTORM_MODE:
            connectorInfo = CONNECTOR_INFOS[ConnectorType.BRAINSTORM_MODE as number];
            break;
    }

    // Need to switch to native?
    // Some connectors only run in the native app.
    const canExecuteHere = connectorInfo ? requiresSwitchingToNative(connectorInfo) : false;

    // Initial attempt to auto-trigger the authorization.
    const didAuthOnce = React.useRef<boolean>(false);
    React.useEffect(() => {
        if (
            didAuthOnce.current ||
            state == null ||
            state.connectorParams == null ||
            canExecuteHere ||
            connectorAuthCheck != ConnectorAuthCheck.AUTHENTICATION_NOT_STARTED
        ) {
            return;
        }
        didAuthOnce.current = true;
        switch (state?.connectorParams?.type) {
            case SALESFORCE_DATA_CLOUD:
                // Only start the auth flow if we know we can support it.
                // Right now, the Salesforce connector only works locally.
                // salesforceAuthFlow({
                //     type: CONNECT,
                //     value: {
                //         instanceUrl: state.connectorParams.value.instanceUrl ?? '', // XXX Warn if params make no sense
                //         appConsumerKey: state.connectorParams.value.appConsumerKey ?? '',
                //         appConsumerSecret: null,
                //     },
                // });
                break;
            case HYPER_DATABASE:
                break;
            case BRAINSTORM_MODE:
                break;
        }
    }, [state, connectorAuthCheck]);

    // Replace the script content with the inlined text after authentication finished.
    // We could think about replacing the script earlier but it's not visible anyway.
    const didLoadScriptOnce = React.useRef<boolean>(false);
    React.useEffect(() => {
        if (
            didLoadScriptOnce.current ||
            state == null ||
            state.connectorParams == null ||
            connectorInfo !== selectedScript?.connectorInfo ||
            connectorAuthCheck != ConnectorAuthCheck.AUTHENTICATED
        ) {
            return;
        }
        didLoadScriptOnce.current = true;
        const update: any = {};
        if (state.scriptText !== null) {
            update[ScriptKey.MAIN_SCRIPT] = state.scriptText;
        }
        if (state.schemaText !== null) {
            update[ScriptKey.SCHEMA_SCRIPT] = state.schemaText;
        }
        selectedScriptDispatch({ type: REPLACE_SCRIPT_CONTENT, value: update });
    }, [state, selectedScript, connectorAuthCheck]);

    // Get the auth status
    // const canContinue = connectorAuthCheck === null || connectorAuthCheck === ConnectorAuthCheck.AUTHENTICATED;
    // let statusText: string = 'ready';
    // switch (connectorAuthCheck) {
    //     case ConnectorAuthCheck.AUTHENTICATED:
    //         statusText = 'Authenticated';
    //         break;
    //     case ConnectorAuthCheck.AUTHENTICATION_IN_PROGRESS:
    //         statusText = 'Authentication In Progress';
    //         break;
    //     case ConnectorAuthCheck.AUTHENTICATION_NOT_STARTED:
    //     case ConnectorAuthCheck.CLIENT_ID_MISMATCH:
    //         statusText = 'Authentication Required';
    //         break;
    //     case ConnectorAuthCheck.AUTHENTICATION_FAILED:
    //         statusText = 'Authentication Failed';
    //         break;
    //     case ConnectorAuthCheck.UNKNOWN:
    //         statusText = '';
    //         break;
    // }


    // Collect all sections (after parsing the params)
    let sections: React.ReactElement[] = [];
    if (state) {
        if (!connectorInfo) {
            // Unknown connector
            sections.push(
                <div key={sections.length} className={page_styles.card_section}>
                    <div className={page_styles.card_section_description}>
                        Connector is unsupported
                    </div>
                </div>);
        } else {
            if (((state?.scriptText?.length ?? 0) > 0) || ((state?.schemaText?.length ?? 0) > 0)) {
                sections.push(
                    <div key={sections.length} className={page_styles.card_section}>
                        <div className={page_styles.section_entries}>
                            {(state?.scriptText?.length ?? 0) > 0 &&
                                <TextField
                                    name="Inline Script"
                                    value={state?.scriptText ?? ""}
                                    readOnly={true}
                                    disabled={true}
                                    leadingVisual={() => <div>Script text with 0 characters</div>}
                                />
                            }
                            {(state?.schemaText?.length ?? 0) > 0 &&
                                <TextField
                                    name="Inline Schema"
                                    value={state?.schemaText ?? ""}
                                    readOnly={true}
                                    disabled={true}
                                    leadingVisual={() => <div>Schema text with 0 characters</div>}
                                />
                            }
                        </div>
                    </div>
                );
            }
            // Do we have connector params?
            // Then render them in a dedicated section.
            if (state.connectorParams) {
                sections.push(<ConnectorParamsSection key={sections.length} params={state?.connectorParams} />);
            }

            // Do we need to switch to native?
            // Render a warning, information where to get the app and a button to switch.
            if (canExecuteHere) {
                const appLink = new URL(`sqlynx://localhost?${props.searchParams.toString()}`);
                sections.push(
                    <div key={sections.length} className={page_styles.card_actions}>
                        <Button
                            className={page_styles.card_action_right}
                            variant="primary"
                            onClick={() => {
                                logger.info(`opening deep link: ${appLink}`);
                                const link = document.createElement('a');
                                link.href = appLink.toString();
                                link.click();
                            }}>
                            Open App
                        </Button>
                    </div>
                );

            } else {
                // We can stay here, render normal action bar
                sections.push(
                    <div key={sections.length} className={page_styles.card_actions}>
                        <Button
                            className={page_styles.card_action_right}
                            variant="primary"
                            onClick={console.log}>
                            Continue
                        </Button>
                    </div>
                );
            }
        }
    }

    // Render the page
    return (
        <div className={page_styles.page}>
            <div className={page_styles.banner_container}>
                <div className={page_styles.banner_logo}>
                    <svg width="100%" height="100%">
                        <use xlinkHref={`${symbols}#sqlynx-inverted`} />
                    </svg>
                </div>
                <div className={page_styles.banner_text_container}>
                    <div className={page_styles.banner_title}>sqlynx</div>
                    <div className={page_styles.app_version}>version {SQLYNX_VERSION}</div>
                </div>
            </div>
            <div className={page_styles.card_container}>
                <div className={page_styles.card_header}>
                    <div className={page_styles.card_header_left_container}>
                        Setup
                    </div>
                    <div className={page_styles.card_header_right_container}>
                        <IconButton
                            variant="invisible"
                            icon={() => (
                                <svg width="16px" height="16px">
                                    <use xlinkHref={`${symbols}#log`} />
                                </svg>
                            )}
                            aria-label="close-overlay"
                            onClick={() => setLogsAreOpen(s => !s)}
                        />
                        {logsAreOpen && <LogViewerInPortal onClose={() => setLogsAreOpen(false)} />}
                    </div>
                </div>
                {sections}
            </div>
        </div>
    );
};
