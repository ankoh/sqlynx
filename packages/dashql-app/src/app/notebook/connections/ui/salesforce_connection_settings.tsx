import * as React from 'react';
import * as style from './connection_settings.module.css';
import * as connection from '@ankoh/dashql-jsonschema/connection.js';

import { KeyIcon, PersonIcon } from '../../../../ui/foundations/symbol_icon.js';

import { findNotebookForAttachedDatabase, useAttachedDatabaseById, useAttachedDatabaseRegistry } from '../attached_database_registry.js';
import { ConnectionHealth, ConnectionStatus } from '../attached_database_state.js';
import { performHealthCheck } from '../health_check.js';
import { useQueryExecutor } from '../query_executor.js';
import { useSalesforceSetup } from '../salesforce/salesforce_connector.js';
import { getSalesforceConnectionDetails } from '../salesforce/salesforce_connection_state.js';
import {
    TextField,
    TextFieldValidationStatus,
    VALIDATION_ERROR,
    VALIDATION_UNKNOWN,
} from '../../../../ui/foundations/text_field.js';
import { IndicatorStatus } from '../../../../ui/foundations/status_indicator.js';
import { classNames } from '../../../../utils/classnames.js';
import { Logger } from '../../../../platform/logger/logger.js';
import { CONNECTOR_INFOS, ConnectorType, HYPER_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR, TRINO_CONNECTOR } from '../connector_info.js';
import { isNativePlatform } from '../../../../platform/native_globals.js';
import { ConnectionStateDetailsVariant } from '../connection_state_details.js';
import type { DetailedError } from '../connection_types.js';
import { useAnyConnectionNotebookScripts } from './connection_notebook_scripts.js';
import { ConnectionInlineHeader } from './connection_inline_header.js';
import { collectSalesforceAuthInfo, getSalesforceDataCloudUrl } from '../salesforce/salesforce_api_client.js';

const LOG_CTX = "sf_connector";

interface PageState {
    hyperProtocol: connection.HyperProtocol;
    instanceUrl: string;
    appConsumerKey: string;
    dataCloudInstanceUrl: string;
    dataCloudTenantId: string;
};

export function getConnectionStatusText(status: ConnectionStatus | undefined, logger: Logger) {
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
        case ConnectionStatus.ACCESS_TOKEN_REQUESTED:
            return "Requesting access token";
        case ConnectionStatus.ACCESS_TOKEN_RECEIVED:
            return "Received access token";
        case ConnectionStatus.CORE_ACCESS_TOKEN_REQUESTED:
            return "Requesting Salesforce OrgJWT";
        case ConnectionStatus.CORE_ACCESS_TOKEN_RECEIVED:
            return "Received Salesforce OrgJWT";
        case ConnectionStatus.CHANNEL_SETUP_STARTED:
            return "Creating channel";
        case ConnectionStatus.CHANNEL_SETUP_FAILED:
            return "Failed to create channel";
        case ConnectionStatus.CHANNEL_SETUP_CANCELLED:
            return "Cancelled channel setup";
        case ConnectionStatus.CHANNEL_READY:
            return "Channel is ready";
        case ConnectionStatus.HEALTH_CHECK_STARTED:
            return "Health check started";
        case ConnectionStatus.HEALTH_CHECK_FAILED:
            return "Health check failed";
        case ConnectionStatus.HEALTH_CHECK_CANCELLED:
            return "Health check cancelled";
        case ConnectionStatus.HEALTH_CHECK_SUCCEEDED:
            return "Health check succeeded";
        case undefined:
            break;
        default:
            logger.warn("unexpected connection status", { "status": status });
    }
    return "";
}

export function getConnectionHealthIndicator(health: ConnectionHealth | null) {
    switch (health) {
        case ConnectionHealth.NOT_STARTED:
            return IndicatorStatus.None;
        case ConnectionHealth.ONLINE:
            return IndicatorStatus.Succeeded;
        case ConnectionHealth.FAILED:
            return IndicatorStatus.Failed;
        case ConnectionHealth.CONNECTING:
            return IndicatorStatus.Running;
        default:
            return IndicatorStatus.None;
    }
}

export function getConnectionError(status: ConnectionStateDetailsVariant | null): (DetailedError | null) {
    switch (status?.type) {
        case TRINO_CONNECTOR:
            return (status.value.proto.channelError ?? status.value.proto.healthCheckError ?? null) as DetailedError | null;
        case SALESFORCE_DATA_CLOUD_CONNECTOR:
            return (status.value.proto.channelError ?? status.value.proto.healthCheckError ?? null) as DetailedError | null;
        case HYPER_CONNECTOR:
            return (status.value.proto.channelError ?? status.value.proto.healthCheckError ?? null) as DetailedError | null;
        default:
            return null;
    }
}

interface Props {
    databaseId: string | null;
    onClose?: () => void;
}

export interface SalesforceConnectionAliasField {
    inputRef?: React.Ref<HTMLInputElement>;
    value: string;
    onChange: React.ChangeEventHandler<HTMLInputElement>;
    validation?: TextFieldValidationStatus;
}

interface SalesforceConnectionSettingsPageProps {
    connectionState: ReturnType<typeof useAttachedDatabaseById>[0];
    notebookScripts: ReturnType<typeof useAnyConnectionNotebookScripts>;
    hyperProtocol: connection.HyperProtocol;
    protocols?: connection.HyperProtocol[];
    wrongPlatform: boolean;
    freezeInput: boolean;
    instanceUrl: string;
    appConsumerKey: string;
    login: string;
    orgJwt: string;
    dataCloudInstanceUrl: string;
    coreTenantId: string;
    dataCloudTenantId: string;
    instanceUrlValidation: TextFieldValidationStatus;
    appConsumerValidation: TextFieldValidationStatus;
    dataCloudInstanceUrlValidation: TextFieldValidationStatus;
    dataCloudTenantIdValidation: TextFieldValidationStatus;
    setHyperProtocol: (protocol: connection.HyperProtocol) => void;
    updateInstanceUrl: React.ChangeEventHandler<HTMLInputElement>;
    updateAppConsumerKey: React.ChangeEventHandler<HTMLInputElement>;
    updateDataCloudInstanceUrl: React.ChangeEventHandler<HTMLInputElement>;
    updateDataCloudTenantId: React.ChangeEventHandler<HTMLInputElement>;
    setupConnection: () => void;
    cancelSetup: () => void;
    resetSetup: () => void;
    onClose?: () => void;
    alias?: SalesforceConnectionAliasField;
    connectorNameAction?: React.ReactNode;
    statusText?: string;
    indicatorStatus?: IndicatorStatus;
    statusError?: string | null;
    connectionHealth?: ConnectionHealth;
}

export const SalesforceConnectionSettingsPage: React.FC<SalesforceConnectionSettingsPageProps> = props => {
    const connectorInfo = CONNECTOR_INFOS[ConnectorType.SALESFORCE_DATA_CLOUD];
    return (
        <div className={style.layout}>
            <ConnectionInlineHeader
                connector={connectorInfo}
                connection={props.connectionState}
                wrongPlatform={props.wrongPlatform}
                setupConnection={props.setupConnection}
                cancelSetup={props.cancelSetup}
                resetSetup={props.resetSetup}
                notebookScripts={props.notebookScripts}
                protocol={props.hyperProtocol}
                protocols={props.protocols ?? ["V3_GRPC", "V3_HTTP"]}
                onProtocolChange={props.setHyperProtocol}
                freezeInput={props.freezeInput}
                onClose={props.onClose}
                statusText={props.statusText}
                indicatorStatus={props.indicatorStatus}
                statusError={props.statusError}
                connectionHealth={props.connectionHealth}
                connectorNameAction={props.connectorNameAction}
            />
            <div className={style.body_container}>
                {props.alias && (
                    <div className={style.section}>
                        <div className={classNames(style.section_layout, style.body_section_layout)}>
                            <TextField
                                inputRef={props.alias.inputRef}
                                name="Attached Database Alias"
                                caption="Name saved in login history and used to address this attached database in the shell"
                                value={props.alias.value}
                                onChange={props.alias.onChange}
                                placeholder="Alias"
                                leadingVisual={() => <div>AS</div>}
                                validation={props.alias.validation}
                                logContext={LOG_CTX}
                                disabled={props.freezeInput}
                                readOnly={props.freezeInput}
                            />
                        </div>
                    </div>
                )}
                <div className={style.section}>
                    <div className={classNames(style.section_layout, style.body_section_layout)}>
                        <TextField
                            name="Salesforce Instance URL"
                            caption="URL of the Salesforce Instance"
                            value={props.instanceUrl}
                            onChange={props.updateInstanceUrl}
                            placeholder="Salesforce Instance"
                            leadingVisual={() => <div>URL</div>}
                            validation={props.instanceUrlValidation}
                            logContext={LOG_CTX}
                            disabled={props.freezeInput}
                            readOnly={props.freezeInput}
                        />
                        <TextField
                            name="Connected App"
                            caption="Setup > App Manager > [App] > Manage Consumer Details"
                            value={props.appConsumerKey}
                            onChange={props.updateAppConsumerKey}
                            placeholder="Consumer Key"
                            leadingVisual={() => <div>ID</div>}
                            validation={props.appConsumerValidation}
                            logContext={LOG_CTX}
                            disabled={props.freezeInput}
                            readOnly={props.freezeInput}
                        />
                        <TextField
                            name="Data Cloud Instance URL"
                            caption="Tenant Endpoint of the Data Cloud Instance"
                            value={props.dataCloudInstanceUrl}
                            onChange={props.updateDataCloudInstanceUrl}
                            placeholder=""
                            leadingVisual={() => <div>URL</div>}
                            validation={props.dataCloudInstanceUrlValidation}
                            readOnly={props.freezeInput}
                            disabled={props.freezeInput}
                            logContext={LOG_CTX}
                        />
                        <TextField
                            name="Data Cloud Tenant ID"
                            caption="Required CDP tenant ID for Data Cloud APIs"
                            value={props.dataCloudTenantId}
                            onChange={props.updateDataCloudTenantId}
                            placeholder=""
                            leadingVisual={() => <div>ID</div>}
                            validation={props.dataCloudTenantIdValidation}
                            readOnly={props.freezeInput}
                            disabled={props.freezeInput}
                            logContext={LOG_CTX}
                        />
                    </div>
                </div>
                <div className={style.section}>
                    <div className={classNames(style.section_layout, style.body_section_layout)}>
                        <TextField
                            name="OrgJWT"
                            caption="Salesforce organization JWT for Core and Data Cloud APIs"
                            value={props.orgJwt}
                            placeholder=""
                            leadingVisual={KeyIcon}
                            readOnly
                            disabled
                            logContext={LOG_CTX}
                        />
                        <TextField
                            name="Login"
                            caption="Account offered as the sign-in hint"
                            value={props.login}
                            placeholder=""
                            leadingVisual={PersonIcon}
                            readOnly
                            disabled
                            logContext={LOG_CTX}
                        />
                    </div>
                </div>
                <div className={style.section}>
                    <div className={classNames(style.section_layout, style.body_section_layout)}>
                        <TextField
                            name="Core Tenant ID"
                            caption="Tenant id for core apis"
                            value={props.coreTenantId}
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

export const SalesforceConnectorSettings: React.FC<Props> = (props: Props) => {
    const sfSetup = useSalesforceSetup();
    const queryExecutor = useQueryExecutor();

    // Resolve connection state
    const [registry] = useAttachedDatabaseRegistry();
    const notebookId = props.databaseId == null ? null : findNotebookForAttachedDatabase(registry, props.databaseId);
    const [connectionState, dispatchAttachedDatabaseState] = useAttachedDatabaseById(props.databaseId);
    const connectionNotebookScripts = useAnyConnectionNotebookScripts(notebookId);
    const salesforceConnection = getSalesforceConnectionDetails(connectionState);

    // Seed the form state from the restored connection params so a notebook
    // that was saved across an app restart displays its endpoint/key.
    // Re-seeds whenever the stored setupParams reference changes (notebook
    // switch, async storage hydration, or an action like RESET that swaps
    // the wrapper state).
    const buildPageState = (params: connection.SalesforceConnectionParams | undefined): PageState => ({
        hyperProtocol: params?.hyperProtocol ?? "V3_HTTP",
        instanceUrl: params?.instanceUrl ?? "",
        appConsumerKey: params?.appConsumerKey ?? "",
        dataCloudInstanceUrl: params?.dataCloudInstanceUrl ?? "",
        dataCloudTenantId: params?.dataCloudTenantId ?? "",
    });
    const [pageState, setPageState] = React.useState<PageState>(() =>
        buildPageState(salesforceConnection?.proto.setupParams));
    const seededParamsRef = React.useRef(salesforceConnection?.proto.setupParams);
    React.useEffect(() => {
        const params = salesforceConnection?.proto.setupParams;
        if (params !== seededParamsRef.current) {
            seededParamsRef.current = params;
            setPageState(buildPageState(params));
        }
    }, [salesforceConnection]);
    const hyperProtocol = pageState.hyperProtocol;

    // gRPC requires the native platform
    const wrongPlatform = hyperProtocol === "V3_GRPC" && !isNativePlatform();
    const setHyperProtocol = (v: connection.HyperProtocol) => setPageState(s => ({ ...s, hyperProtocol: v }));
    const updateInstanceUrl: React.ChangeEventHandler<HTMLInputElement> = ev => setPageState(s => ({ ...s, instanceUrl: ev.target.value }));
    const updateAppConsumerKey: React.ChangeEventHandler<HTMLInputElement> = ev => setPageState(s => ({ ...s, appConsumerKey: ev.target.value }));
    const updateDataCloudInstanceUrl: React.ChangeEventHandler<HTMLInputElement> = ev => setPageState(s => ({ ...s, dataCloudInstanceUrl: ev.target.value }));
    const updateDataCloudTenantId: React.ChangeEventHandler<HTMLInputElement> = ev => setPageState(s => ({ ...s, dataCloudTenantId: ev.target.value }));

    // Maintain setting validations
    const [instanceUrlValidation, setInstanceUrlValidation] = React.useState<TextFieldValidationStatus>({
        type: VALIDATION_UNKNOWN,
        value: null
    });
    const [appConsumerValidation, setAppConsumerValidation] = React.useState<TextFieldValidationStatus>({
        type: VALIDATION_UNKNOWN,
        value: null
    });
    const [dataCloudInstanceUrlValidation, setDataCloudInstanceUrlValidation] = React.useState<TextFieldValidationStatus>({ type: VALIDATION_UNKNOWN, value: null });
    const [dataCloudTenantIdValidation, setDataCloudTenantIdValidation] = React.useState<TextFieldValidationStatus>({ type: VALIDATION_UNKNOWN, value: null });

    // Helper to start the authorization.
    // Carry a previously resolved/shared login through as the OAuth login_hint. It is not a
    // user-editable field here — it is populated after connect from the userinfo endpoint or
    // seeded from a shared link — so we read it straight from the restored setupParams.
    const restoredLogin = salesforceConnection?.proto.setupParams?.login ?? "";
    const setupParams = React.useMemo<connection.SalesforceConnectionParams>(() => ({
        hyperProtocol: pageState.hyperProtocol,
        instanceUrl: pageState.instanceUrl,
        appConsumerKey: pageState.appConsumerKey,
        appConsumerSecret: "",
        dataCloudInstanceUrl: pageState.dataCloudInstanceUrl.trim(),
        dataCloudTenantId: pageState.dataCloudTenantId.trim(),
        login: restoredLogin,
    }), [pageState.hyperProtocol, pageState.instanceUrl, pageState.appConsumerKey, pageState.dataCloudInstanceUrl, pageState.dataCloudTenantId, restoredLogin]);
    const setupAbortController = React.useRef<AbortController | null>(null);
    const setupConnection = async () => {
        let validationSucceeded = true;
        if (pageState.instanceUrl == "") {
            validationSucceeded = false;
            setInstanceUrlValidation({ type: VALIDATION_ERROR, value: "Instance URL cannot be empty" });
        } else {
            setInstanceUrlValidation({ type: VALIDATION_UNKNOWN, value: null });
        }
        if (pageState.appConsumerKey === "") {
            validationSucceeded = false;
            setAppConsumerValidation({ type: VALIDATION_ERROR, value: "Connected App cannot be empty" });
        } else {
            setAppConsumerValidation({ type: VALIDATION_UNKNOWN, value: null });
        }
        try {
            getSalesforceDataCloudUrl(setupParams.dataCloudInstanceUrl);
            setDataCloudInstanceUrlValidation({ type: VALIDATION_UNKNOWN, value: null });
        } catch (error) {
            validationSucceeded = false;
            setDataCloudInstanceUrlValidation({ type: VALIDATION_ERROR, value: error instanceof Error ? error.message : String(error) });
        }
        if (!setupParams.dataCloudTenantId) {
            validationSucceeded = false;
            setDataCloudTenantIdValidation({ type: VALIDATION_ERROR, value: "Data Cloud Tenant ID cannot be empty" });
        } else {
            setDataCloudTenantIdValidation({ type: VALIDATION_UNKNOWN, value: null });
        }
        if (!validationSucceeded || !sfSetup) return;

        try {
            setupAbortController.current = new AbortController();
            const sfChannel = await sfSetup.setup(dispatchAttachedDatabaseState, setupParams, setupAbortController.current.signal);
            if (connectionState != null) {
                await performHealthCheck(queryExecutor, connectionState.databaseId, { type: 'salesforce', channel: sfChannel }, dispatchAttachedDatabaseState, setupAbortController.current.signal);
            }
        } catch {
            // Setup updates connection state with the failure details.
        } finally {
            setupAbortController.current = null;
        }
    };

    // Helper to cancel and reset the setup
    const cancelSetup = () => {
        if (setupAbortController.current) {
            setupAbortController.current.abort("abort the authorization flow");
            setupAbortController.current = null;
        }
    };
    const resetSetup = async () => {
        if (sfSetup) {
            await sfSetup.reset(dispatchAttachedDatabaseState);
        }
    };

    let freezeInput = false;
    switch (connectionState?.connectionHealth) {
        case ConnectionHealth.NOT_STARTED:
        case ConnectionHealth.FAILED:
        case ConnectionHealth.CANCELLED:
            break;
        case ConnectionHealth.CONNECTING:
            freezeInput = true;
            break;
        case ConnectionHealth.ONLINE:
            freezeInput = true;
            break;
    }

    // Read the auth info
    const coreAccessToken = salesforceConnection?.proto.oauthState?.coreAccessToken;
    const dcAuthInfo = coreAccessToken
        ? collectSalesforceAuthInfo(coreAccessToken, setupParams)
        : null;

    // Lock any changes?
    return (
        <SalesforceConnectionSettingsPage
            connectionState={connectionState}
            notebookScripts={connectionNotebookScripts}
            hyperProtocol={hyperProtocol}
            wrongPlatform={wrongPlatform}
            freezeInput={freezeInput}
            instanceUrl={pageState.instanceUrl}
            appConsumerKey={pageState.appConsumerKey}
            login={restoredLogin}
            orgJwt={dcAuthInfo?.offcoreRawJwt ?? ''}
            dataCloudInstanceUrl={pageState.dataCloudInstanceUrl}
            coreTenantId={dcAuthInfo?.coreTenantId ?? ''}
            dataCloudTenantId={pageState.dataCloudTenantId}
            instanceUrlValidation={instanceUrlValidation}
            appConsumerValidation={appConsumerValidation}
            dataCloudInstanceUrlValidation={dataCloudInstanceUrlValidation}
            dataCloudTenantIdValidation={dataCloudTenantIdValidation}
            setHyperProtocol={setHyperProtocol}
            updateInstanceUrl={updateInstanceUrl}
            updateAppConsumerKey={updateAppConsumerKey}
            updateDataCloudInstanceUrl={updateDataCloudInstanceUrl}
            updateDataCloudTenantId={updateDataCloudTenantId}
            setupConnection={setupConnection}
            cancelSetup={cancelSetup}
            resetSetup={resetSetup}
            onClose={props.onClose}
        />
    );
};
