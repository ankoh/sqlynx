import * as React from 'react';

import { Button } from '@primer/react';
import { KeyIcon, PlugIcon, XIcon } from '@primer/octicons-react';

import { useConnectionState } from '../../connectors/connection_registry.js';
import { useSalesforceConnectionId } from '../../connectors/salesforce_connector.js';
import { useSalesforceAuthFlow } from '../../connectors/salesforce_auth_flow.js';
import { ConnectionHealth, ConnectionStatus, getSalesforceConnectionStatus, getSalesforceConnectionHealth, asSalesforceConnection, ConnectionState } from '../../connectors/connection_state.js';
import { SalesforceAuthParams } from '../../connectors/connection_params.js';
import { SalesforceAuthAction, reduceAuthState, RESET } from '../../connectors/salesforce_connection_state.js';
import { SALESFORCE_DATA_CLOUD_CONNECTOR } from '../../connectors/connector_info.js';
import { TextField, TextFieldValidationStatus, VALIDATION_ERROR, VALIDATION_UNKNOWN } from '../text_field.js';
import { IndicatorStatus, StatusIndicator } from '../status_indicator.js';
import { Dispatch } from '../../utils/variant.js';
import { classNames } from '../../utils/classnames.js';

import * as symbols from '../../../static/svg/symbols.generated.svg';
import * as style from './connector_settings.module.css';

const LOG_CTX = "sf_connector";

interface PageState {
    instanceUrl: string;
    appConsumerKey: string;
};
type PageStateSetter = Dispatch<React.SetStateAction<PageState>>;
const PAGE_STATE_CTX = React.createContext<[PageState, PageStateSetter] | null>(null);

export const SalesforceConnectorSettings: React.FC<{}> = (_props: {}) => {
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
        const salesforceAuthDispatch = (action: SalesforceAuthAction) => {
            setConnectionState((c: ConnectionState) => {
                const s = asSalesforceConnection(c)!;
                return {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: reduceAuthState(s, action)
                };
            });
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
        setConnectionState((c: ConnectionState) => {
            const s = asSalesforceConnection(c)!;
            return {
                type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                value: reduceAuthState(s, { type: RESET, value: null })
            };
        });
    };

    // Get the connection status
    const status = getSalesforceConnectionStatus(salesforceConnection);
    let statusName: string | undefined = undefined;
    switch (status) {
        case ConnectionStatus.UNKNOWN:
        case ConnectionStatus.NOT_STARTED:
            statusName = "Disconnected";
            break;
        case ConnectionStatus.AUTHORIZATION_FAILED:
            statusName = "Authorization failed";
            break;
        case ConnectionStatus.AUTHORIZATION_COMPLETED:
            statusName = "Authorization successful";
            break;
        case ConnectionStatus.WAITING_FOR_OAUTH_CODE_VIA_LINK:
        case ConnectionStatus.WAITING_FOR_OAUTH_CODE_VIA_WINDOW:
            statusName = "Waiting for OAuth code";
            break;
        case ConnectionStatus.OAUTH_CODE_RECEIVED:
            statusName = "Received OAuth code";
            break;
        case ConnectionStatus.CORE_ACCESS_TOKEN_REQUESTED:
            statusName = "Requesting core access token";
            break;
        case ConnectionStatus.DATA_CLOUD_TOKEN_REQUESTED:
            statusName = "Requesting Data Cloud access token";
            break;
        case ConnectionStatus.PKCE_GENERATION_STARTED:
            statusName = "Generating pkce challenge";
            break;
    }

    // Get the indicator status
    const health = getSalesforceConnectionHealth(status);
    let indicatorStatus: IndicatorStatus | undefined = undefined;
    switch (health) {
        case ConnectionHealth.UNKNOWN:
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
    let actionButton: React.ReactElement = <div />;
    switch (health) {
        case ConnectionHealth.UNKNOWN:
        case ConnectionHealth.NOT_STARTED:
        case ConnectionHealth.FAILED:
            actionButton = <Button variant='primary' leadingVisual={PlugIcon} onClick={startAuth}>Connect</Button>;
            break;
        case ConnectionHealth.CONNECTING:
            actionButton = <Button variant='danger' leadingVisual={XIcon} onClick={cancelAuth}>Cancel</Button>;
            break;
        case ConnectionHealth.ONLINE:
            actionButton = <Button variant='danger' leadingVisual={XIcon} onClick={resetAuth}>Reset</Button>;
            break;
    }

    // Lock any changes?
    const freezeInput = health == ConnectionHealth.CONNECTING || health == ConnectionHealth.ONLINE;
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
                    {actionButton}
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
                                {statusName}
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

interface ProviderProps { children: React.ReactElement };

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
