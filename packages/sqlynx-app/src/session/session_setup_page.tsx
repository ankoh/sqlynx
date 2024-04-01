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
} from '../connectors/connector_info.js';
import { ConnectorSetupParamVariant, checkSalesforceAuthSetup, readConnectorParamsFromURL } from '../connectors/connector_url_params.js';
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
    connectorParams: ConnectorSetupParamVariant | null;
}

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

    // Check the auth setup
    let connectorInfo: ConnectorInfo | null = null;
    let connectorAuthCheck: ConnectorAuthCheck | null = null;
    switch (state?.connectorParams?.type) {
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

    // Distinguish the different connector types
    const authOnce = React.useRef<boolean>(false);
    React.useEffect(() => {
        if (
            authOnce.current ||
            state == null ||
            state.connectorParams == null ||
            connectorAuthCheck != ConnectorAuthCheck.AUTHENTICATION_NOT_STARTED
        ) {
            return;
        }
        authOnce.current = true;
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
    const loadedOnce = React.useRef<boolean>(false);
    React.useEffect(() => {
        if (
            loadedOnce.current ||
            state == null ||
            state.connectorParams == null ||
            connectorInfo !== selectedScript?.connectorInfo ||
            connectorAuthCheck != ConnectorAuthCheck.AUTHENTICATED
        ) {
            return;
        }
        loadedOnce.current = true;
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

    // Render connector options
    let connectorOptionsSection: React.ReactElement = <div />;
    switch (state?.connectorParams?.type) {
        case SALESFORCE_DATA_CLOUD:
            console.log(state.connectorParams);
            connectorOptionsSection = (
                <div className={page_styles.card_section}>
                    <div className={page_styles.section_entries}>
                        <TextField
                            name="Salesforce Instance URL"
                            value={state.connectorParams.value.instanceUrl ?? ""}
                            readOnly={true}
                            disabled={true}
                            leadingVisual={() => <div>URL</div>}
                        />
                        <TextField
                            name="Connected App"
                            value={state.connectorParams.value.appConsumerKey ?? ""}
                            readOnly={true}
                            disabled={true}
                            leadingVisual={() => <div>ID</div>}
                        />
                    </div>
                </div>
            );
            break;
    }

    // Construct the page
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
                <div className={page_styles.card_section}>
                    <div className={page_styles.section_entries}>
                        <TextField
                            name="Inline Script"
                            value={state?.scriptText ?? ""}
                            readOnly={true}
                            disabled={true}
                            leadingVisual={() => <div>Base64 script text with 0 characters</div>}
                        />
                        {(state?.schemaText?.length ?? 0) > 0 &&
                            <TextField
                                name="Inline Schema"
                                value={state?.schemaText ?? ""}
                                readOnly={true}
                                disabled={true}
                                leadingVisual={() => <div>Text</div>}
                            />
                        }
                    </div>
                </div>
                {connectorOptionsSection}
            </div>
        </div>
    );

    // return (
    //     <div className={styles.page}>
    //         <div className={styles.banner_container}>
    //             <div className={styles.banner_logo}>
    //                 <svg width="100%" height="100%">
    //                     <use xlinkHref={`${symbols}#sqlynx-inverted`} />
    //                 </svg>
    //             </div>
    //             <div className={styles.banner_text_container}>
    //                 <div className={styles.banner_title}>sqlynx</div>
    //                 <div className={styles.app_version}>version {SQLYNX_VERSION ?? '-'}</div>
    //             </div>
    //         </div>
    //         <div className={styles.card_container}>
    //             <div className={styles.card_header}>
    //                 <div>Setup</div>
    //             </div>
    //             <div className={styles.card_section}>
    //                 <div className={styles.card_section_header}>SQL</div>
    //                 <div className={styles.detail_entries}>
    //                     <DetailEntry label="Inline Script">
    //                         <Bean text={(state?.scriptText?.length ?? 0) + ' chars'} />
    //                     </DetailEntry>
    //                     <DetailEntry label="Inline Schema">
    //                         <Bean text={(state?.schemaText?.length ?? 0) + ' chars'} />
    //                     </DetailEntry>
    //                 </div>
    //             </div>
    //             <div className={styles.card_section}>
    //                 <div className={styles.card_section_header}>Connector</div>
    //                 <div className={styles.detail_entries}>
    //                     <DetailEntry label="Connector Type">
    //                         <Bean text={connectorInfo?.displayName.long ?? 'unknown'} />
    //                     </DetailEntry>
    //                     <DetailEntry label="Supported Platforms">
    //                         {connectorInfo?.platforms.native ? <Bean text="Native" /> : undefined}
    //                         {connectorInfo?.platforms.browser ? <Bean text="Web" /> : undefined}
    //                     </DetailEntry>
    //                     {state?.connectorParams?.type == SALESFORCE_DATA_CLOUD && (
    //                         <>
    //                             <DetailEntry label="Instance Url">
    //                                 <Bean text={state?.connectorParams.value.instanceUrl ?? 'not set'} />
    //                             </DetailEntry>
    //                             <DetailEntry label="Connected App">
    //                                 <Bean text={state?.connectorParams.value.appConsumerKey ?? 'not set'} />
    //                             </DetailEntry>
    //                         </>
    //                     )}
    //                 </div>
    //             </div>
    //             <div className={styles.card_actions}>
    //                 {canContinue ? (
    //                     <Button className={styles.card_action_continue} variant="primary" onClick={props.onDone}>
    //                         Continue
    //                     </Button>
    //                 ) : (
    //                     <>
    //                         <Button variant="danger" onClick={props.onDone}>
    //                             Skip
    //                         </Button>
    //                         <div className={styles.card_status_text}>{statusText}</div>
    //                         <IconButton className={styles.card_action_restart} icon={SyncIcon} aria-labelledby="sync" />
    //                     </>
    //                 )}
    //             </div>
    //         </div>
    //     </div>
    // );
};
