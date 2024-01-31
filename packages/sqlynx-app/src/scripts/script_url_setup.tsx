import * as React from 'react';

import LZString from 'lz-string';
import { Button, IconButton } from '@primer/react';
import { SyncIcon } from '@primer/octicons-react';
import { useLocation } from 'react-router-dom';

import {
    CONNECTOR_INFOS,
    ConnectorAuthCheck,
    ConnectorInfo,
    ConnectorType,
    HYPER_DATABASE,
    LOCAL_SCRIPT,
    SALESFORCE_DATA_CLOUD,
} from '../connectors/connector_info';
import { CONNECT, useSalesforceAuthFlow, useSalesforceAuthState } from '../connectors/salesforce_auth_state';
import {
    ConnectorSetupParamVariant,
    checkSalesforceAuthSetup,
    readConnectorParamsFromURL,
} from '../connectors/connector_url_params';
import { useSQLynx, useSQLynxLoadingProgress } from '../sqlynx_loader';
import { RESULT_OK, formatBytes, formatNanoseconds } from '../utils';

import styles from './script_url_setup.module.css';

import symbols from '../../static/svg/symbols.generated.svg';
import { useSelectedScriptState, useSelectedScriptStateDispatch } from './script_state_provider';
import { REPLACE_SCRIPT_CONTENT } from './script_state_reducer';
import { ScriptKey } from './script_state';

interface Props {
    params: URLSearchParams;
    onDone: () => void;
}

interface State {
    scriptText: string | null;
    schemaText: string | null;
    connectorParams: ConnectorSetupParamVariant | null;
}

const ScriptURLSetupPage: React.FC<Props> = (props: Props) => {
    const lnx = useSQLynx();
    const salesforceAuth = useSalesforceAuthState();
    const salesforceAuthFlow = useSalesforceAuthFlow();
    const selectedScript = useSelectedScriptState();
    const selectedScriptDispatch = useSelectedScriptStateDispatch();
    const [state, setState] = React.useState<State | null>(null);

    // Get instantiation progress
    let moduleVersion: string | null = null;
    if (lnx?.type == RESULT_OK) {
        moduleVersion = lnx.value.getVersionText();
    }

    // Read script parameters
    React.useEffect(() => {
        // Read the inline scripts
        const scriptParam = props.params.get('script');
        const schemaParam = props.params.get('schema');
        let scriptText = null;
        let schemaText = null;
        if (scriptParam !== null) {
            scriptText = LZString.decompressFromBase64(scriptParam);
        }
        if (schemaParam !== null) {
            schemaText = LZString.decompressFromBase64(schemaParam);
        }
        // Unpack the URL parameters
        const connectorParams = readConnectorParamsFromURL(props.params);
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
        case LOCAL_SCRIPT:
            connectorInfo = CONNECTOR_INFOS[ConnectorType.LOCAL_SCRIPT as number];
            break;
    }

    // Initial auth trigger
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
                salesforceAuthFlow({
                    type: CONNECT,
                    value: {
                        instanceUrl: state.connectorParams.value.instanceUrl ?? '', // XXX Warn if params make no sense
                        appConsumerKey: state.connectorParams.value.appConsumerKey ?? '',
                        appConsumerSecret: null,
                    },
                });
                break;
            case HYPER_DATABASE:
                break;
            case LOCAL_SCRIPT:
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
    const canContinue = connectorAuthCheck === null || connectorAuthCheck === ConnectorAuthCheck.AUTHENTICATED;
    let statusText: string = 'ready';
    switch (connectorAuthCheck) {
        case ConnectorAuthCheck.AUTHENTICATED:
            statusText = 'Authenticated';
            break;
        case ConnectorAuthCheck.AUTHENTICATION_IN_PROGRESS:
            statusText = 'Authentication In Progress';
            break;
        case ConnectorAuthCheck.AUTHENTICATION_NOT_STARTED:
        case ConnectorAuthCheck.CLIENT_ID_MISMATCH:
            statusText = 'Authentication Required';
            break;
        case ConnectorAuthCheck.AUTHENTICATION_FAILED:
            statusText = 'Authentication Failed';
            break;
        case ConnectorAuthCheck.UNKNOWN:
            statusText = '';
            break;
    }

    const DetailEntry = (props: {
        label: string;
        children: (React.ReactElement | undefined)[] | React.ReactElement;
    }) => (
        <>
            <div className={styles.detail_entry_key}>{props.label}</div>
            <div className={styles.detail_entry_value}>{props.children}</div>
        </>
    );
    const Bean = (props: { text: string }) => <span className={styles.bean}>{props.text}</span>;

    return (
        <div className={styles.page}>
            <div className={styles.banner_container}>
                <div className={styles.banner_logo}>
                    <svg width="100%" height="100%">
                        <use xlinkHref={`${symbols}#sqlynx-inverted`} />
                    </svg>
                </div>
                <div className={styles.banner_text_container}>
                    <div className={styles.banner_title}>sqlynx</div>
                    <div className={styles.app_version}>v{moduleVersion ?? '-'}</div>
                </div>
            </div>
            <div className={styles.card_container}>
                <div className={styles.card_header}>
                    <div className={styles.card_title}>Setup</div>
                </div>
                <div className={styles.card_section}>
                    <div className={styles.card_section_header}>SQL</div>
                    <div className={styles.detail_entries}>
                        <DetailEntry label="Inline Script">
                            <Bean text={(state?.scriptText?.length ?? 0) + ' chars'} />
                        </DetailEntry>
                        <DetailEntry label="Inline Schema">
                            <Bean text={(state?.schemaText?.length ?? 0) + ' chars'} />
                        </DetailEntry>
                    </div>
                </div>
                <div className={styles.card_section}>
                    <div className={styles.card_section_header}>Connector</div>
                    <div className={styles.detail_entries}>
                        <DetailEntry label="Connector Type">
                            <Bean text={connectorInfo?.displayName.long ?? 'unknown'} />
                        </DetailEntry>
                        <DetailEntry label="Supported Platforms">
                            {connectorInfo?.platforms.native ? <Bean text="Native" /> : undefined}
                            {connectorInfo?.platforms.browser ? <Bean text="Web" /> : undefined}
                        </DetailEntry>
                        {state?.connectorParams?.type == SALESFORCE_DATA_CLOUD && (
                            <>
                                <DetailEntry label="Instance Url">
                                    <Bean text={state?.connectorParams.value.instanceUrl ?? 'not set'} />
                                </DetailEntry>
                                <DetailEntry label="Connected App">
                                    <Bean text={state?.connectorParams.value.appConsumerKey ?? 'not set'} />
                                </DetailEntry>
                            </>
                        )}
                    </div>
                </div>
                <div className={styles.card_actions}>
                    {canContinue ? (
                        <Button className={styles.card_action_continue} variant="primary" onClick={props.onDone}>
                            Continue
                        </Button>
                    ) : (
                        <>
                            <Button className={styles.skip_button} variant="danger" onClick={props.onDone}>
                                Skip
                            </Button>
                            <div className={styles.card_status_text}>{statusText}</div>
                            <IconButton className={styles.card_action_restart} icon={SyncIcon} aria-labelledby="sync" />
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

enum SetupVisibility {
    UNDECIDED,
    SKIP,
    SHOW,
}

export const ScriptURLSetup: React.FC<{ children: React.ReactElement }> = (props: { children: React.ReactElement }) => {
    const [showSetup, setShowSetup] = React.useState<SetupVisibility>(SetupVisibility.UNDECIDED);
    const location = useLocation();
    const params = React.useMemo(() => new URLSearchParams(location.search), []);
    React.useEffect(() => {
        if (!params.has('connector')) {
            setShowSetup(SetupVisibility.SKIP);
        } else {
            setShowSetup(SetupVisibility.SHOW);
        }
    }, []);
    switch (showSetup) {
        case SetupVisibility.UNDECIDED:
            return <div />;
        case SetupVisibility.SKIP:
            return props.children;
        case SetupVisibility.SHOW:
            return <ScriptURLSetupPage params={params} onDone={() => setShowSetup(SetupVisibility.SKIP)} />;
    }
};
