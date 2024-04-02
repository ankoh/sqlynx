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
    UNKNOWN_CONNECTOR,
} from '../connectors/connector_info.js';
import { ConnectorSetupParamVariant, UnsupportedSetupParams, checkSalesforceAuthSetup, readConnectorParamsFromURL } from '../connectors/connector_url_params.js';
import { useSalesforceAuthState } from '../connectors/salesforce_auth_state.js';
import { REPLACE_SCRIPT_CONTENT } from './session_state_reducer.js';
import { useActiveSessionState, useActiveSessionStateDispatch } from './session_state_provider.js';
import { ScriptKey } from './session_state.js';
import { SQLYNX_VERSION } from '../globals.js';
import { TextField } from '../view/text_field.js';
import { LogViewerInPortal } from '../view/log_viewer.js';

import page_styles from '../view/banner_page.module.css';

import * as symbols from '../../static/svg/symbols.generated.svg';

interface Props {
    searchParams: URLSearchParams;
    onDone: () => void;
}

interface State {
    scriptText: string | null;
    schemaText: string | null;
    connectorParams: ConnectorSetupParamVariant;
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

const ConnectorIsUnsupported: React.FC<{ params: UnsupportedSetupParams }> = (props: { params: UnsupportedSetupParams }) => {
    return <div />;
};

export const SessionSetupPage: React.FC<Props> = (props: Props) => {
    const [logsAreOpen, setLogsAreOpen] = React.useState<boolean>(false);

    const salesforceAuth = useSalesforceAuthState();
    const selectedScript = useActiveSessionState();
    const selectedScriptDispatch = useActiveSessionStateDispatch();
    const [state, setState] = React.useState<State | null>(null);

    // Read script parameters
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
    switch (state?.connectorParams.type) {
        case SALESFORCE_DATA_CLOUD:
            connectorInfo = CONNECTOR_INFOS[ConnectorType.SALESFORCE_DATA_CLOUD as number];
            connectorAuthCheck = checkSalesforceAuthSetup(salesforceAuth, state.connectorParams.value);
            break;
        case HYPER_DATABASE:
            connectorInfo = CONNECTOR_INFOS[ConnectorType.HYPER_DATABASE as number];
            break;
        case BRAINSTORM_MODE:
            connectorInfo = CONNECTOR_INFOS[ConnectorType.BRAINSTORM_MODE as number];
            break;
    }

    // Initial attempt to auto-trigger the authorization
    const didAuthOnce = React.useRef<boolean>(false);
    React.useEffect(() => {
        if (
            didAuthOnce.current ||
            state == null ||
            state.connectorParams == null ||
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

    // Replace the script content with the inlined text after authentication finished
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


    let sections: React.ReactElement[] = [];

    // Did not parse the url params yet?
    if (!state) {
        sections.push(<div>State is empty</div>);
    } else if (state.connectorParams.type === UNKNOWN_CONNECTOR) {
        sections.push(<div>Connector is unsupported</div>);
    } else {
        sections.push(
            <div className={page_styles.card_section}>
                <div className={page_styles.section_entries}>
                    <TextField
                        name="Inline Script"
                        value={state?.scriptText ?? ""}
                        readOnly={true}
                        disabled={true}
                        leadingVisual={() => <div>Script text with 0 characters</div>}
                    />
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
        if (state.connectorParams) {
            sections.push(<ConnectorParamsSection params={state?.connectorParams} />);
            sections.push(
                <div className={page_styles.card_actions}>
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


    // if (requiresSwitchingToNative(!connectorInfo?.platforms.browser)) {

    // }

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
