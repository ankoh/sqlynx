import * as React from 'react';

import * as connection from '@ankoh/dashql-jsonschema/connection.js';
import * as auth from '@ankoh/dashql-jsonschema/auth.js';

import * as style from './connection_settings.module.css';

import { BookIcon, KeyIcon, PlugIcon, XIcon } from '../../../ui/foundations/symbol_icon.js';

import { Button, ButtonVariant } from '../../../ui/foundations/button.js';
import { ConnectionHealth } from '../connection_state.js';
import { Dispatch } from '../../../utils/variant.js';
import { KeyValueListBuilder, KeyValueListElement, UpdateKeyValueList } from '../../../ui/foundations/keyvalue_list.js';
import { TextField, VALIDATION_WARNING } from '../../../ui/foundations/text_field.js';
import { classNames } from '../../../utils/classnames.js';
import { useConnectionById, useConnectionDraftForm } from '../connection_registry.js';
import { useConnectionSave } from '../connection_persistence.js';
import { useConnectionSetup } from './connection_setup.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import { useQueryExecutor } from '../query_executor.js';
import { performHealthCheck } from '../health_check.js';
import { useTrinoSetup } from '../trino/trino_connector.js';
import { CONNECTOR_INFOS, ConnectorType, requiresSwitchingToNative, TRINO_CONNECTOR } from '../connector_info.js';
import { UpdateValueList, ValueListBuilder } from '../../../ui/foundations/value_list.js';
import { ConnectionInlineHeader } from './connection_inline_header.js';
import { SegmentedControl } from '../../../ui/foundations/segmented_control.js';
import { LoggableException, stringifyError } from '../../../platform/logger/logger.js';

const LOG_CTX = "trino_connector";

interface PageState {
    activeParams: connection.TrinoConnectionParams | null;
    newParams: connection.TrinoConnectionParams;
    newParamsMetadata: KeyValueListElement[];
};

const DEFAULT_TRINO_PARAMS: connection.TrinoConnectionParams = {
    endpoint: "http://localhost:8080",
    auth: {
        authType: "AUTH_BASIC",
        basic: {
            username: "",
            secret: "",
        }
    },
    metadata: {
        message: ""
    },
    catalogName: "",
    schemaNames: [],
};

export function buildPageStateFromParams(params: connection.TrinoConnectionParams | null | undefined): PageState {
    const active = params ?? null;
    const newParams = params ?? DEFAULT_TRINO_PARAMS;
    const metadataData = newParams.metadata ?? {};
    return {
        activeParams: active,
        newParams,
        newParamsMetadata: params?.draftRows?.metadata ?? Object.entries(metadataData).map(([k, v]) => ({ key: k, value: v ?? "" })),
    };
}

interface Props {
    connectionId: string | null;
    onClose?: () => void;
    headerActions?: React.ReactNode;
}

export const TrinoConnectorSettings: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const trinoSetup = useTrinoSetup();
    const queryExecutor = useQueryExecutor();

    // Can we use the connector here?
    const connectorInfo = CONNECTOR_INFOS[ConnectorType.TRINO];
    const wrongPlatform = requiresSwitchingToNative(connectorInfo);

    // Resolve connection state
    const [connectionState, dispatchConnectionState] = useConnectionById(props.connectionId);
    const connectionSetup = useConnectionSetup(props.connectionId);
    const { saving } = useConnectionSave(props.connectionId);

    const [pageState, setPageState] = useConnectionDraftForm(props.connectionId,
        params => buildPageStateFromParams(params && 'trino' in params ? params.trino as connection.TrinoConnectionParams : undefined),
        form => ({ trino: { ...form.newParams, draftRows: { metadata: form.newParamsMetadata } } }));

    const endpoint = pageState.newParams?.endpoint;
    const setEndpoint = (v: string) => setPageState(s => ({
        ...s,
        newParams: {
            ...s.newParams,
            endpoint: v
        },
    }));
    const authType = pageState.newParams?.auth?.authType ?? "AUTH_BASIC";
    const setAuthType = (t: auth.AuthType) => setPageState(s => ({
        ...s,
        newParams: {
            ...s.newParams,
            auth: {
                authType: t,
            },
        },
    }));
    const basicAuthUsername = pageState.newParams?.auth?.basic?.username;
    const setBasicAuthUsername: Dispatch<string> = (v: string) => setPageState(s => ({
        ...s,
        newParams: {
            ...s.newParams,
            auth: {
                authType: "AUTH_BASIC",
                basic: {
                    username: v,
                    secret: s.newParams.auth?.basic?.secret ?? "",
                },
            },
        }
    }));
    const basicAuthSecret = pageState.newParams?.auth?.basic?.secret;
    const setBasicAuthSecret: Dispatch<string> = (v: string) => setPageState(s => ({
        ...s,
        newParams: {
            ...s.newParams,
            auth: {
                authType: "AUTH_BASIC",
                basic: {
                    username: s.newParams?.auth?.basic?.username ?? "",
                    secret: v,
                },
            },
        }
    }));
    const oauthAuthEndpoint = pageState.newParams.auth?.oauth?.authorizationUrl;
    const setOAuthAuthEndpoint: Dispatch<string> = (v: string) => setPageState(s => ({
        ...s,
        newParams: {
            ...s.newParams,
            auth: {
                authType: "AUTH_OAUTH",
                oauth: {
                    authorizationUrl: v,
                    tokenUrl: s.newParams?.auth?.oauth?.tokenUrl ?? "",
                    clientId: s.newParams?.auth?.oauth?.clientId ?? "",
                    callbackUrl: s.newParams?.auth?.oauth?.callbackUrl ?? "",
                    scopes: s.newParams?.auth?.oauth?.scopes ?? [],
                },
            },
        }
    }));

    const oauthTokenEndpoint = pageState.newParams.auth?.oauth?.tokenUrl;
    const setOAuthTokenEndpoint: Dispatch<string> = (v: string) => setPageState(s => ({
        ...s,
        newParams: {
            ...s.newParams,
            auth: {
                authType: "AUTH_OAUTH",
                oauth: {
                    authorizationUrl: s.newParams?.auth?.oauth?.authorizationUrl ?? "",
                    tokenUrl: v,
                    clientId: s.newParams?.auth?.oauth?.clientId ?? "",
                    callbackUrl: s.newParams?.auth?.oauth?.callbackUrl ?? "",
                    scopes: s.newParams?.auth?.oauth?.scopes ?? [],
                },
            },
        }
    }));

    const oauthClientId = pageState.newParams.auth?.oauth?.clientId;
    const setOAuthClientId: Dispatch<string> = (v: string) => setPageState(s => ({
        ...s,
        newParams: {
            ...s.newParams,
            auth: {
                authType: "AUTH_OAUTH",
                oauth: {
                    authorizationUrl: s.newParams?.auth?.oauth?.authorizationUrl ?? "",
                    tokenUrl: s.newParams?.auth?.oauth?.tokenUrl ?? "",
                    clientId: v,
                    callbackUrl: s.newParams?.auth?.oauth?.callbackUrl ?? "",
                    scopes: s.newParams?.auth?.oauth?.scopes ?? [],
                },
            },
        }
    }));

    const oauthRedirectUrl = pageState.newParams.auth?.oauth?.callbackUrl;
    const setOAuthRedirectUrl: Dispatch<string> = (v: string) => setPageState(s => ({
        ...s,
        newParams: {
            ...s.newParams,
            auth: {
                authType: "AUTH_OAUTH",
                oauth: {
                    authorizationUrl: s.newParams?.auth?.oauth?.authorizationUrl ?? "",
                    tokenUrl: s.newParams?.auth?.oauth?.tokenUrl ?? "",
                    clientId: s.newParams?.auth?.oauth?.clientId ?? "",
                    callbackUrl: v,
                    scopes: s.newParams?.auth?.oauth?.scopes ?? [],
                },
            },
        }
    }));

    const oauthScopes = pageState.newParams.auth?.oauth?.scopes ?? [];
    const modifyOAuthScopes: Dispatch<UpdateValueList> = (action: UpdateValueList) => setPageState(s => ({
        ...s,
        newParams: {
            ...s.newParams,
            auth: {
                authType: "AUTH_OAUTH",
                oauth: {
                    authorizationUrl: s.newParams?.auth?.oauth?.authorizationUrl ?? "",
                    tokenUrl: s.newParams?.auth?.oauth?.tokenUrl ?? "",
                    clientId: s.newParams?.auth?.oauth?.clientId ?? "",
                    callbackUrl: s.newParams?.auth?.oauth?.callbackUrl ?? "",
                    scopes: action(s.newParams?.auth?.oauth?.scopes ?? []),
                },
            },
        }
    }));


    const setCatalogName: Dispatch<string> = (v: string) => setPageState(s => ({
        ...s,
        newParams: {
            ...s.newParams,
            catalogName: v
        }
    }));
    const modifySchemaNames: Dispatch<UpdateValueList> = (action: UpdateValueList) => setPageState(s => ({
        ...s,
        newParams: {
            ...s.newParams,
            schemaNames: action(s.newParams.schemaNames ?? [])
        }
    }));
    const modifyMetadata: Dispatch<UpdateKeyValueList> = (action: UpdateKeyValueList) => setPageState(s => {
        const metadata = action(s.newParamsMetadata);

        // Flatten the key-value list eagerly for the new params.
        // We could decide to do this lazily but it shouldn't really matter.
        const metadataObj: Record<string, string> = {};
        for (const entry of metadata) {
            metadataObj[entry.key] = entry.value;
        }
        return {
            ...s,
            newParamsMetadata: metadata,
            newParams: {
                ...s.newParams,
                metadata: metadataObj
            }
        };
    });

    // Helper to setup the connection
    const setupConnection = async () => {
        // Is there a Trino client?
        if (trinoSetup == null) {
            logger.error("Trino connector is unavailable", {}, LOG_CTX);
            return;
        }
        // Is there a connection id?
        if (connectionState == null) {
            logger.warn("Trino connection state is null", {}, LOG_CTX);
            return;
        }

        await connectionSetup.run(async signal => {
            try {
                const connectionParams: connection.TrinoConnectionParams = pageState.newParams;
                const trinoChannel = await trinoSetup.setup(dispatchConnectionState, connectionParams, signal);
                if (trinoChannel != null) {
                    await performHealthCheck(queryExecutor, connectionState.connectionId, { type: 'trino', channel: trinoChannel }, dispatchConnectionState, signal);
                }
            } catch (error: any) {
                if (error instanceof LoggableException) {
                    logger.warn(error.message, error.keyValues, error.target);
                } else {
                    logger.warn("Error while setting up trino connection", {
                        authType: (pageState.newParams.auth?.authType ?? 0).toString(),
                        error: stringifyError(error)
                    }, LOG_CTX);
                }
            }
        });
    };
    const cancelSetup = connectionSetup.cancel;
    const resetSetup = async () => {
        if (trinoSetup) {
            await trinoSetup.reset(dispatchConnectionState);
        }
    };

    // Get the action button
    let connectButton: React.ReactElement = <div />;
    // Saving writes the settings into every session that uses the connection
    let freezeInput = saving;
    switch (connectionState?.connectionHealth) {
        case ConnectionHealth.NOT_STARTED:
        case ConnectionHealth.FAILED:
            connectButton = <Button variant={ButtonVariant.Primary} leadingVisual={PlugIcon} onClick={setupConnection}>Connect</Button>;
            break;
        case ConnectionHealth.CONNECTING:
            connectButton = <Button variant={ButtonVariant.Danger} leadingVisual={XIcon} onClick={cancelSetup}>Cancel</Button>;
            freezeInput = true;
            break;
        case ConnectionHealth.ONLINE:
            connectButton = <Button variant={ButtonVariant.Danger} leadingVisual={XIcon} onClick={resetSetup}>Disconnect</Button>;
            break;
    }

    return (
        <div className={style.layout}>
            <ConnectionInlineHeader
                connector={connectorInfo}
                connection={connectionState}
                wrongPlatform={wrongPlatform}
                setupConnection={setupConnection}
                cancelSetup={cancelSetup}
                resetSetup={resetSetup}
                onClose={props.onClose}
                headerActions={props.headerActions}
            />
            <div className={style.body_container}>
                <div className={style.section}>
                    <div className={classNames(style.section_layout, style.body_section_layout)}>
                        <TextField
                            name="Endpoint"
                            caption="Endpoint of the Trino Api as 'https://host:port'"
                            value={endpoint}
                            placeholder=""
                            validation={
                                (endpoint.length ?? 0) == 0
                                    ? { type: VALIDATION_WARNING, value: "Endpoint is empty" }
                                    : undefined
                            }
                            leadingVisual={() => <div>URL</div>}
                            onChange={(e) => setEndpoint(e.target.value)}
                            disabled={freezeInput}
                            readOnly={freezeInput}
                            autoComplete={false}
                            logContext={LOG_CTX}
                        />
                    </div>
                </div>
                <div className={style.section}>
                    <div className={classNames(style.section_layout, style.body_section_layout)}>
                        <div className={style.section_header}>
                            <SegmentedControl
                                aria-label="Authentication type"
                                onChange={(index) => {
                                    const newAuthType = index === 0
                                        ? "AUTH_BASIC"
                                        : "AUTH_OAUTH";
                                    setAuthType(newAuthType);
                                }}
                            >
                                <SegmentedControl.Button
                                    selected={authType === "AUTH_BASIC"}
                                    disabled={freezeInput}
                                >
                                    Basic
                                </SegmentedControl.Button>
                                <SegmentedControl.Button
                                    selected={authType === "AUTH_OAUTH"}
                                    disabled={freezeInput}
                                >
                                    OAuth 2.0
                                </SegmentedControl.Button>
                            </SegmentedControl>
                        </div>
                        <TextField
                            style={{ display: authType == "AUTH_BASIC" ? 'block' : 'none' }}
                            name="Username"
                            caption="Username for the Trino Api"
                            placeholder=""
                            validation={
                                (basicAuthUsername?.length ?? 0) == 0
                                    ? { type: VALIDATION_WARNING, value: "Username is empty" }
                                    : undefined
                            }
                            leadingVisual={() => <div>ID</div>}
                            value={basicAuthUsername ?? ""}
                            onChange={(e) => setBasicAuthUsername(e.target.value)}
                            disabled={freezeInput}
                            readOnly={freezeInput}
                            autoComplete={false}
                            logContext={LOG_CTX}
                        />
                        <TextField
                            style={{ display: authType == "AUTH_BASIC" ? 'block' : 'none' }}
                            name="Secret"
                            caption="Password for the Trino Api"
                            placeholder=""
                            validation={
                                (basicAuthSecret?.length ?? 0) == 0
                                    ? { type: VALIDATION_WARNING, value: "Secret is empty" }
                                    : undefined
                            }
                            leadingVisual={KeyIcon}
                            value={basicAuthSecret ?? ""}
                            onChange={(e) => setBasicAuthSecret(e.target.value)}
                            disabled={freezeInput}
                            readOnly={freezeInput}
                            concealed={true}
                            logContext={LOG_CTX}
                        />
                        <TextField
                            style={{ display: authType == "AUTH_OAUTH" ? 'block' : 'none' }}
                            name="Authorization Url"
                            caption="Url to start the OAuth flow"
                            placeholder=""
                            validation={
                                (pageState.newParams.auth?.oauth?.authorizationUrl.length ?? 0) == 0
                                    ? { type: VALIDATION_WARNING, value: "Authorization Url is empty" }
                                    : undefined
                            }
                            leadingVisual={() => <div>URL</div>}
                            value={oauthAuthEndpoint ?? ""}
                            onChange={(e) => setOAuthAuthEndpoint(e.target.value)}
                            disabled={freezeInput}
                            readOnly={freezeInput}
                            autoComplete={false}
                            logContext={LOG_CTX}
                        />
                        <TextField
                            style={{ display: authType == "AUTH_OAUTH" ? 'block' : 'none' }}
                            name="Token Url"
                            caption="Url to retrieve an Access Token"
                            placeholder=""
                            validation={
                                (pageState.newParams.auth?.oauth?.tokenUrl.length ?? 0) == 0
                                    ? { type: VALIDATION_WARNING, value: "Token Endpoint is empty" }
                                    : undefined
                            }
                            leadingVisual={() => <div>URL</div>}
                            value={oauthTokenEndpoint ?? ""}
                            onChange={(e) => setOAuthTokenEndpoint(e.target.value)}
                            disabled={freezeInput}
                            readOnly={freezeInput}
                            autoComplete={false}
                            logContext={LOG_CTX}
                        />
                        <TextField
                            style={{ display: authType == "AUTH_OAUTH" ? 'block' : 'none' }}
                            name="Client ID"
                            caption="Client ID of the OAuth application"
                            placeholder=""
                            validation={
                                (pageState.newParams.auth?.oauth?.clientId?.length ?? 0) == 0
                                    ? { type: VALIDATION_WARNING, value: "Client ID is empty" }
                                    : undefined
                            }
                            leadingVisual={() => <div>ID</div>}
                            value={oauthClientId ?? ""}
                            onChange={(e) => setOAuthClientId(e.target.value)}
                            disabled={freezeInput}
                            readOnly={freezeInput}
                            autoComplete={false}
                            logContext={LOG_CTX}
                        />
                        <TextField
                            style={{ display: authType == "AUTH_OAUTH" ? 'block' : 'none' }}
                            name="Redirect URL"
                            caption="Redirect URL of the OAuth application"
                            placeholder=""
                            validation={
                                (pageState.newParams.auth?.oauth?.callbackUrl?.length ?? 0) == 0
                                    ? { type: VALIDATION_WARNING, value: "Redirect URL is empty" }
                                    : undefined
                            }
                            leadingVisual={() => <div>URL</div>}
                            value={oauthRedirectUrl ?? ""}
                            onChange={(e) => setOAuthRedirectUrl(e.target.value)}
                            disabled={freezeInput}
                            readOnly={freezeInput}
                            autoComplete={false}
                            logContext={LOG_CTX}
                        />
                        <ValueListBuilder
                            title="Scope"
                            caption="OAuth scopes"
                            valueIcon={() => <div>Scope</div>}
                            addButtonLabel="Add Scope"
                            elements={oauthScopes}
                            modifyElements={modifyOAuthScopes}
                            disabled={freezeInput}
                            readOnly={freezeInput}
                        />
                    </div>
                </div>
                <div className={style.section}>
                    <div className={classNames(style.section_layout, style.body_section_layout)}>
                        <TextField
                            name="Catalog"
                            caption="Name of the Trino Catalog"
                            value={pageState.newParams.catalogName}
                            placeholder=""
                            validation={
                                (pageState.newParams.catalogName.length ?? 0) == 0
                                    ? { type: VALIDATION_WARNING, value: "Catalog is empty" }
                                    : undefined
                            }
                            leadingVisual={BookIcon}
                            onChange={(e) => setCatalogName(e.target.value)}
                            disabled={freezeInput}
                            readOnly={freezeInput}
                            autoComplete={false}
                            logContext={LOG_CTX}
                        />
                        <ValueListBuilder
                            title="Schemas"
                            caption="Names of the Trino Schemas"
                            valueIcon={() => <div>Value</div>}
                            addButtonLabel="Add Value"
                            elements={pageState.newParams.schemaNames ?? []}
                            modifyElements={modifySchemaNames}
                            disabled={freezeInput}
                            readOnly={freezeInput}
                        />
                    </div>
                </div>
                <div className={style.section}>
                    <div className={classNames(style.section_layout, style.body_section_layout)}>
                        <KeyValueListBuilder
                            title="Additional Metadata"
                            caption="Extra HTTP headers that are added to each request"
                            keyIcon={() => <div>Header</div>}
                            valueIcon={() => <div>Value</div>}
                            addButtonLabel="Add Header"
                            elements={pageState.newParamsMetadata}
                            modifyElements={modifyMetadata}
                            disabled={freezeInput}
                            readOnly={freezeInput}
                        />
                    </div>
                </div>
            </div>
        </ div>
    );
};
