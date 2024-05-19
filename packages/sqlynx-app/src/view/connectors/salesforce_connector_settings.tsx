import * as React from 'react';

import { Button } from '@primer/react';
import { KeyIcon, PlugIcon } from '@primer/octicons-react';

import { useConnectionState } from '../../connectors/connection_registry.js';
import { useSalesforceConnectionId } from '../../connectors/salesforce_connector.js';
import { useSalesforceAuthFlow } from '../../connectors/salesforce_auth_flow.js';
import { ConnectionHealth, ConnectionStatus, getSalesforceConnectionStatus, getSalesforceConnnectionHealth, asSalesforceConnection, ConnectionState } from '../../connectors/connection_state.js';
import { SalesforceAuthParams } from '../../connectors/connector_configs.js';
import { SalesforceAuthAction, reduceAuthState } from '../../connectors/salesforce_auth_state.js';
import { SALESFORCE_DATA_CLOUD } from '../../connectors/connector_info.js';
import { TextField, TextFieldValidationStatus, VALIDATION_ERROR, VALIDATION_OK, VALIDATION_UNKNOWN } from '../../view/text_field.js';
import { IndicatorStatus, StatusIndicator } from '../../view/status_indicator.js';
import { classNames } from '../../utils/classnames.js';

import * as symbols from '../../../static/svg/symbols.generated.svg';
import * as style from './connector_settings.module.css';

const LOG_CTX = "sf_connector";

interface Props { }

export const SalesforceConnectorSettings: React.FC<Props> = (
    _props: Props,
) => {
    const [instanceUrl, setInstanceUrl] = React.useState<string>("");
    const [appConsumerKey, setAppConsumerKey] = React.useState<string>("");
    const [_appConsumerSecret, _setAppConsumerSecret] = React.useState<string | null>(null);

    // Resolve the connection
    const connectionId = useSalesforceConnectionId();
    const [connectionState, setConnectionState] = useConnectionState(connectionId);
    const salesforceConnection = asSalesforceConnection(connectionState);
    const salesforceAuthFlow = useSalesforceAuthFlow();
    const isAuthenticated = false;

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
    const startAuth = async () => {
        let validationSucceeded = true;
        if (instanceUrl === "") {
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
        if (appConsumerKey === "") {
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
                    type: SALESFORCE_DATA_CLOUD,
                    value: {
                        ...s,
                        auth: reduceAuthState(s.auth, action)
                    }
                };
            });
        };
        // Authorize the client
        const abortController = new AbortController();
        const authParams: SalesforceAuthParams = {
            instanceUrl: instanceUrl,
            appConsumerKey: appConsumerKey,
            appConsumerSecret: null,
        };
        await salesforceAuthFlow.authorize(salesforceAuthDispatch, authParams, abortController.signal);
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
            statusName = "Authorization successfull";
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

    // Get the connection health
    const health = getSalesforceConnnectionHealth(status);
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
                    <Button
                        variant='primary'
                        leadingVisual={PlugIcon}
                        onClick={startAuth}
                    >Connect</Button>
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
                            value={instanceUrl}
                            onChange={(e) => setInstanceUrl(e.target.value)}
                            placeholder="Salesforce Instance"
                            leadingVisual={() => <div>URL</div>}
                            validation={instanceUrlValidation}
                            logContext={LOG_CTX}
                        />
                        <TextField
                            name="Connected App"
                            caption="Setup > App Manager > [App] > Manage Consumer Details"
                            value={appConsumerKey}
                            onChange={(e) => setAppConsumerKey(e.target.value)}
                            placeholder="Consumer Key"
                            leadingVisual={() => <div>ID</div>}
                            validation={appConsumerValidation}
                            logContext={LOG_CTX}
                        />
                    </div>
                </div>
                <div className={style.section}>
                    <div className={classNames(style.section_layout, style.body_section_layout)}>
                        <TextField
                            name="Instance API URL"
                            caption="URL of the Salesforce API"
                            value={salesforceConnection?.auth.coreAccessToken?.apiInstanceUrl ?? ''}
                            onChange={() => { }}
                            placeholder=""
                            leadingVisual={() => <div>URL</div>}
                            readOnly
                            disabled={!isAuthenticated}
                            logContext={LOG_CTX}
                        />
                        <TextField
                            name="Core Access Token"
                            caption="Access Token for Salesforce Core"
                            value={salesforceConnection?.auth.coreAccessToken?.accessToken ?? ''}
                            onChange={() => { }}
                            placeholder=""
                            leadingVisual={KeyIcon}
                            readOnly
                            disabled={!isAuthenticated}
                            logContext={LOG_CTX}
                        />
                    </div>
                </div>
                <div className={style.section}>
                    <div className={classNames(style.section_layout, style.body_section_layout)}>
                        <TextField
                            name="Data Cloud Instance URL"
                            caption="URL of the Data Cloud instance"
                            value={salesforceConnection?.auth.dataCloudAccessToken?.instanceUrl?.toString() ?? ''}
                            onChange={() => { }}
                            placeholder=""
                            leadingVisual={() => <div>URL</div>}
                            readOnly
                            disabled={!isAuthenticated}
                            logContext={LOG_CTX}
                        />
                        <TextField
                            name="Data Cloud Access Token"
                            caption="URL of the Data Cloud instance"
                            value={salesforceConnection?.auth.dataCloudAccessToken?.jwt?.raw ?? ''}
                            onChange={() => { }}
                            placeholder=""
                            leadingVisual={KeyIcon}
                            readOnly
                            disabled={!isAuthenticated}
                            logContext={LOG_CTX}
                        />
                        <TextField
                            name="Core Tenant ID"
                            caption="Tenant id for core apis"
                            value={salesforceConnection?.auth.dataCloudAccessToken?.coreTenantId ?? ''}
                            onChange={() => { }}
                            placeholder=""
                            leadingVisual={() => <div>ID</div>}
                            readOnly
                            disabled={!isAuthenticated}
                            logContext={LOG_CTX}
                        />
                        <TextField
                            name="Data Cloud Tenant ID"
                            caption="Tenant id for Data Cloud apis"
                            value={salesforceConnection?.auth.dataCloudAccessToken?.dcTenantId ?? ''}
                            onChange={() => { }}
                            placeholder=""
                            leadingVisual={() => <div>ID</div>}
                            readOnly
                            disabled={!isAuthenticated}
                            logContext={LOG_CTX}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};
