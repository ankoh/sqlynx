import * as React from 'react';
import * as symbols from '../../../static/svg/symbols.generated.svg';
import * as style from './connector_settings.module.css';

import { FileSymlinkFileIcon, KeyIcon, PlugIcon, XIcon } from '@primer/octicons-react';

import { useConnectionState } from '../../connectors/connection_registry.js';
import { useSalesforceConnectionId } from '../../connectors/salesforce_connector.js';
import { useSalesforceAuthFlow } from '../../connectors/salesforce_auth_flow.js';
import { ConnectionState } from '../../connectors/connection_state.js';
import { SalesforceAuthParams } from '../../connectors/connection_params.js';
import {
    asSalesforceConnection,
    reduceSalesforceConnectionState,
    RESET,
    SalesforceConnectionStateAction,
} from '../../connectors/salesforce_connection_state.js';
import { TextField, TextFieldValidationStatus, VALIDATION_ERROR, VALIDATION_UNKNOWN } from '../base/text_field.js';
import { IndicatorStatus, StatusIndicator } from '../base/status_indicator.js';
import { Dispatch } from '../../utils/variant.js';
import { classNames } from '../../utils/classnames.js';
import { useLogger } from '../../platform/logger_provider.js';
import { Logger } from '../../platform/logger.js';
import { ConnectionHealth, ConnectionStatus } from '../../connectors/connection_status.js';
import { useSessionStates } from '../../session/session_state_registry.js';
import { useCurrentSessionSelector } from '../../session/current_session.js';
import { useNavigate } from 'react-router-dom';
import { Button, ButtonVariant } from '../base/button.js';

const LOG_CTX = "sf_connector";

interface PageState {
    instanceUrl: string;
    appConsumerKey: string;
};
type PageStateSetter = Dispatch<React.SetStateAction<PageState>>;
const PAGE_STATE_CTX = React.createContext<[PageState, PageStateSetter] | null>(null);

function getConnectionStatusText(status: ConnectionStatus | undefined, logger: Logger) {
    switch (status) {
        case ConnectionStatus.NOT_STARTED:
            return "Disconnected";
        case ConnectionStatus.AUTH_STARTED:
            return "Starting authorization";
        case ConnectionStatus.AUTH_CANCELLED:
            return "Cancelled authorization";
        case ConnectionStatus.AUTH_FAILED:
            return "Authorization failed";
        case ConnectionStatus.PKCE_GENERATION_STARTED:
            return "Generating PKCE challenge";
        case ConnectionStatus.PKCE_GENERATED:
            return "Generated PKCE challenge";
        case ConnectionStatus.WAITING_FOR_OAUTH_CODE_VIA_LINK:
        case ConnectionStatus.WAITING_FOR_OAUTH_CODE_VIA_WINDOW:
            return "Waiting for OAuth code";
        case ConnectionStatus.OAUTH_CODE_RECEIVED:
            return "Received OAuth code";
        case ConnectionStatus.CORE_ACCESS_TOKEN_REQUESTED:
            return "Requesting Core access token";
        case ConnectionStatus.CORE_ACCESS_TOKEN_RECEIVED:
            return "Received Core access token";
        case ConnectionStatus.DATA_CLOUD_TOKEN_REQUESTED:
            return "Requesting Data Cloud access token";
        case ConnectionStatus.DATA_CLOUD_TOKEN_RECEIVED:
            return "Received Data Cloud access token";
        case undefined:
            break;
        default:
            logger.warn(`unexpected connection status: ${status}`);
    }
    return "";
}

export const SalesforceConnectorSettings: React.FC<object> = (_props: object) => {
    const logger = useLogger();
    const connectionId = useSalesforceConnectionId();
    const [connectionState, setConnectionState] = useConnectionState(connectionId);
    const salesforceConnection = asSalesforceConnection(connectionState);
    const salesforceAuthFlow = useSalesforceAuthFlow();

    // Wire up the page state
    const [pageState, setPageState] = React.useContext(PAGE_STATE_CTX)!;
    const updateInstanceUrl: React.ChangeEventHandler<HTMLInputElement> = ev => setPageState(s => ({ ...s, instanceUrl: ev.target.value }));
    const updateAppConsumerKey: React.ChangeEventHandler<HTMLInputElement> = ev => setPageState(s => ({ ...s, appConsumerKey: ev.target.value }));

    // Maintain setting validations
    const [instanceUrlValidation, setInstanceUrlValidation] = React.useState<TextFieldValidationStatus>({
        type: VALIDATION_UNKNOWN,
        value: null
    });
    const [appConsumerValidation, setAppConsumerValidation] = React.useState<TextFieldValidationStatus>({
        type: VALIDATION_UNKNOWN,
        value: null
    });

    // Helper to start the authorization
    const authAbortController = React.useRef<AbortController | null>(null);
    const startAuth = async () => {
        let validationSucceeded = true;
        if (pageState.instanceUrl == "") {
            validationSucceeded = false;
            setInstanceUrlValidation({
                type: VALIDATION_ERROR,
                value: "Instance URL cannot be empty"
            });
        } else {
            setInstanceUrlValidation({
                type: VALIDATION_UNKNOWN,
                value: null
            })
        }
        if (pageState.appConsumerKey === "") {
            validationSucceeded = false;
            setAppConsumerValidation({
                type: VALIDATION_ERROR,
                value: "Connected App cannot be empty"
            });
        } else {
            setAppConsumerValidation({
                type: VALIDATION_UNKNOWN,
                value: null
            })
        }
        if (!validationSucceeded || !salesforceAuthFlow) {
            return;
        }

        // Helper to dispatch auth state actions against the connection state
        const salesforceAuthDispatch = (action: SalesforceConnectionStateAction) => {
            setConnectionState((s: ConnectionState) => reduceSalesforceConnectionState(s, action));
        };
        // Authorize the client
        authAbortController.current = new AbortController();
        const authParams: SalesforceAuthParams = {
            instanceUrl: pageState.instanceUrl,
            appConsumerKey: pageState.appConsumerKey,
            appConsumerSecret: null,
        };
        await salesforceAuthFlow.authorize(salesforceAuthDispatch, authParams, authAbortController.current.signal);
        authAbortController.current = null;
    };

    // Helper to cancel the authorization
    const cancelAuth = () => {
        if (authAbortController.current) {
            authAbortController.current.abort("abort the authorization flow");
            authAbortController.current = null;
        }
    };
    // Helper to reset the authorization
    const resetAuth = () => {
        setConnectionState((s: ConnectionState) => reduceSalesforceConnectionState(s, { type: RESET, value: null }));
    };

    // Find any session that is associated with the connection id
    const sessionRegistry = useSessionStates();
    let anySessionWithThisConnection: number | null = null;
    const sessionsWithThisConnection = sessionRegistry.sessionsByConnection.get(connectionId) ?? [];
    if (sessionsWithThisConnection.length > 0) {
        anySessionWithThisConnection = sessionsWithThisConnection[0];
    }

    // Helper to switch to the editor
    const selectCurrentSession = useCurrentSessionSelector();
    const navigate = useNavigate()
    const switchToEditor = React.useCallback(() => {
        if (anySessionWithThisConnection != null) {
            selectCurrentSession(anySessionWithThisConnection);
            navigate("/editor");
        }
    }, [anySessionWithThisConnection]);

    // Get the connection status
    const statusText = getConnectionStatusText(connectionState?.connectionStatus, logger);

    // Get the indicator status
    let indicatorStatus: IndicatorStatus = IndicatorStatus.None;
    switch (connectionState?.connectionHealth) {
        case ConnectionHealth.NOT_STARTED:
            indicatorStatus = IndicatorStatus.None;
            break;
        case ConnectionHealth.ONLINE:
            indicatorStatus = IndicatorStatus.Succeeded;
            break;
        case ConnectionHealth.FAILED:
            indicatorStatus = IndicatorStatus.Failed;
            break;
        case ConnectionHealth.CONNECTING:
            indicatorStatus = IndicatorStatus.Running;
            break;
    }

    // Get the action button
    let connectButton: React.ReactElement = <div />;
    let freezeInput = false;
    switch (connectionState?.connectionHealth) {
        case ConnectionHealth.NOT_STARTED:
        case ConnectionHealth.FAILED:
            connectButton = <Button variant={ButtonVariant.Primary} leadingVisual={PlugIcon} onClick={startAuth}>Connect</Button>;
            break;
        case ConnectionHealth.CONNECTING:
            connectButton = <Button variant={ButtonVariant.Danger} leadingVisual={XIcon} onClick={cancelAuth}>Cancel</Button>;
            freezeInput = true;
            break;
        case ConnectionHealth.ONLINE:
            connectButton = <Button variant={ButtonVariant.Danger} leadingVisual={XIcon} onClick={resetAuth}>Disconnect</Button>;
            freezeInput = true;
            break;
    }

    // Lock any changes?
    return (
        <div className={style.layout}>
            <div className={style.connector_header_container}>
                <div className={classNames(style.platform_logo, style.salesforce_logo)}>
                    <svg width="28px" height="28px">
                        <use xlinkHref={`${symbols}#salesforce_notext`} />
                    </svg>
                </div>
                <div className={style.platform_name} id="connector-sf-data-cloud">
                    Salesforce Data Cloud
                </div>
                <div className={style.platform_actions}>
                    {(connectionState?.connectionHealth == ConnectionHealth.ONLINE) && (
                        <Button variant={ButtonVariant.Default} leadingVisual={FileSymlinkFileIcon} onClick={switchToEditor}>Open Editor</Button>
                    )}
                    {connectButton}
                </div>
            </div>
            <div className={style.status_container}>
                <div className={classNames(style.section, style.status_section)}>
                    <div className={classNames(style.section_layout, style.status_section_layout)}>
                        <div className={style.status_bar}>
                            <div className={style.status_indicator}>
                                <StatusIndicator className={style.status_indicator_spinner} status={indicatorStatus} fill="black" />
                            </div>
                            <div className={style.status_text}>
                                {statusText}
                            </div>
                            <div className={style.status_stats}>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div className={style.body_container}>
                <div className={style.section}>
                    <div className={classNames(style.section_layout, style.body_section_layout)}>
                        <TextField
                            name="Salesforce Instance URL"
                            caption="URL of the Salesforce Instance"
                            value={pageState.instanceUrl}
                            onChange={updateInstanceUrl}
                            placeholder="Salesforce Instance"
                            leadingVisual={() => <div>URL</div>}
                            validation={instanceUrlValidation}
                            logContext={LOG_CTX}
                            disabled={freezeInput}
                            readOnly={freezeInput}
                        />
                        <TextField
                            name="Connected App"
                            caption="Setup > App Manager > [App] > Manage Consumer Details"
                            value={pageState.appConsumerKey}
                            onChange={updateAppConsumerKey}
                            placeholder="Consumer Key"
                            leadingVisual={() => <div>ID</div>}
                            validation={appConsumerValidation}
                            logContext={LOG_CTX}
                            disabled={freezeInput}
                            readOnly={freezeInput}
                        />
                    </div>
                </div>
                <div className={style.section}>
                    <div className={classNames(style.section_layout, style.body_section_layout)}>
                        <TextField
                            name="Instance API URL"
                            caption="URL of the Salesforce API"
                            value={salesforceConnection?.coreAccessToken?.apiInstanceUrl ?? ''}
                            placeholder=""
                            leadingVisual={() => <div>URL</div>}
                            readOnly
                            disabled
                            logContext={LOG_CTX}
                        />
                        <TextField
                            name="Core Access Token"
                            caption="Access Token for Salesforce Core"
                            value={salesforceConnection?.coreAccessToken?.accessToken ?? ''}
                            placeholder=""
                            leadingVisual={KeyIcon}
                            readOnly
                            disabled
                            logContext={LOG_CTX}
                        />
                    </div>
                </div>
                <div className={style.section}>
                    <div className={classNames(style.section_layout, style.body_section_layout)}>
                        <TextField
                            name="Data Cloud Instance URL"
                            caption="URL of the Data Cloud instance"
                            value={salesforceConnection?.dataCloudAccessToken?.instanceUrl?.toString() ?? ''}
                            placeholder=""
                            leadingVisual={() => <div>URL</div>}
                            readOnly
                            disabled
                            logContext={LOG_CTX}
                        />
                        <TextField
                            name="Data Cloud Access Token"
                            caption="URL of the Data Cloud instance"
                            value={salesforceConnection?.dataCloudAccessToken?.jwt?.raw ?? ''}
                            placeholder=""
                            leadingVisual={KeyIcon}
                            readOnly
                            disabled
                            logContext={LOG_CTX}
                        />
                        <TextField
                            name="Core Tenant ID"
                            caption="Tenant id for core apis"
                            value={salesforceConnection?.dataCloudAccessToken?.coreTenantId ?? ''}
                            placeholder=""
                            leadingVisual={() => <div>ID</div>}
                            readOnly
                            disabled
                            logContext={LOG_CTX}
                        />
                        <TextField
                            name="Data Cloud Tenant ID"
                            caption="Tenant id for Data Cloud apis"
                            value={salesforceConnection?.dataCloudAccessToken?.dcTenantId ?? ''}
                            placeholder=""
                            leadingVisual={() => <div>ID</div>}
                            readOnly
                            disabled
                            logContext={LOG_CTX}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};

interface ProviderProps { children: React.ReactElement }

export const SalesforceConnectorSettingsStateProvider: React.FC<ProviderProps> = (props: ProviderProps) => {
    const state = React.useState<PageState>({
        instanceUrl: "",
        appConsumerKey: "",
    });
    return (
        <PAGE_STATE_CTX.Provider value={state}>
            {props.children}
        </PAGE_STATE_CTX.Provider>
    );
};
