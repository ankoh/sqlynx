import * as React from 'react';

import { TextInput, FormControl, Button, IconButton } from '@primer/react';
import { CopyIcon, InfoIcon } from '@primer/octicons-react';

import { useAppConfig } from '../../state/app_config';
import {
    SalesforceAuthParams,
    useSalesforceAuthState,
    useSalesforceAuthFlow,
    CONNECT,
    DISCONNECT,
    AUTH_FAILED,
} from '../../connectors/salesforce_auth_flow';
import { useSalesforceUserInfo } from '../../connectors/salesforce_userinfo_resolver';
import { Skeleton } from '../../view/skeleton';

import SalesforceDummyAccount from '../../../static/img/salesforce_account_placeholder.png';

import symbols from '../../../static/svg/symbols.generated.svg';

import panelStyle from './salesforce_connector_panel.module.css';
import pageStyle from '../pages/connections_page.module.css';

const ERROR_MISSING_OAUTH_REDIRECT = 'Missing Salesforce OAuth redirect URL';
const ERROR_MISSING_INSTANCE_URL = 'Missing Salesforce instance URL';
const ERROR_MISSING_CLIENT_ID = 'Missing Salesforce client id';
const ERROR_MISSING_OAUTH_CONFIG = 'Missing Salesforce OAuth config';

interface SalesforceAuthFlowProps {
    userAuthParams?: SalesforceAuthParams;
}

const SalesforceAuthFlowPanel: React.FC<SalesforceAuthFlowProps> = (props: SalesforceAuthFlowProps) => {
    const appConfig = useAppConfig();
    const userInfo = useSalesforceUserInfo();
    const authFlow = useSalesforceAuthFlow();
    const auth = useSalesforceAuthState();

    const setError = (msg: string) =>
        authFlow({
            type: AUTH_FAILED,
            value: msg,
        });

    // Select auth parameters
    const authParams = React.useMemo(() => {
        let authParams: SalesforceAuthParams | null = null;
        if (props.userAuthParams !== undefined) {
            authParams = props.userAuthParams;
        } else {
            const connectorConfig = appConfig.value?.connectors?.salesforce;
            if (connectorConfig !== undefined) {
                if (!connectorConfig.oauthRedirect) {
                    setError(ERROR_MISSING_OAUTH_REDIRECT);
                } else if (!connectorConfig.instanceUrl) {
                    setError(ERROR_MISSING_INSTANCE_URL);
                } else if (!connectorConfig.clientId) {
                    setError(ERROR_MISSING_CLIENT_ID);
                } else {
                    authParams = {
                        oauthRedirect: new URL(connectorConfig.oauthRedirect),
                        instanceUrl: new URL(connectorConfig.instanceUrl),
                        clientId: connectorConfig.clientId,
                        clientSecret: connectorConfig.clientSecret ?? null,
                    };
                }
            } else {
                setError(ERROR_MISSING_OAUTH_CONFIG);
            }
        }
        return authParams;
    }, [props.userAuthParams, appConfig]);

    const connect = React.useCallback(() => {
        if (!authParams) {
            // XXX setError not configured
            return;
        }
        authFlow({ type: CONNECT, value: authParams });
    }, [authParams]);
    const disconnect = React.useCallback(() => {
        authFlow({ type: DISCONNECT, value: null });
    }, [authParams]);

    const CopyAction = () => (
        <TextInput.Action
            onClick={() => {
                alert('clear input');
            }}
            icon={CopyIcon}
            aria-label="Clear input"
        />
    );
    const MutableTextBox = (props: {
        name: string;
        caption: string;
        value: string | null;
        onChange: React.ChangeEventHandler<HTMLInputElement>;
    }) => (
        <FormControl sx={{ marginTop: '8px' }}>
            <FormControl.Label>{props.name}</FormControl.Label>
            <TextInput block trailingAction={CopyAction()} value={props.value ?? 'null'} onChange={props.onChange} />
            <FormControl.Caption>{props.caption}</FormControl.Caption>
        </FormControl>
    );
    const LoadingTextBox = (props: { name: string }) => (
        <div className={panelStyle.skeleton_text_box}>
            <div className={panelStyle.skeleton_label}>{props.name}</div>
            <Skeleton className={panelStyle.skeleton_bar} count={1} height={'100%'} />
        </div>
    );
    const ImmutableTextBox = (props: { name: string; value: string | null }) =>
        props.value == null ? (
            <LoadingTextBox name={props.name} />
        ) : (
            <FormControl sx={{ marginTop: '8px' }}>
                <FormControl.Label>{props.name}</FormControl.Label>
                <TextInput block trailingAction={CopyAction()} value={props.value ?? 'null'} readOnly />
            </FormControl>
        );
    const ImmutableSecretBox = (props: { name: string; value: string | null }) =>
        props.value == null ? (
            <LoadingTextBox name={props.name} />
        ) : (
            <FormControl sx={{ marginTop: '8px' }}>
                <FormControl.Label>{props.name}</FormControl.Label>
                <TextInput block type="password" trailingAction={CopyAction()} value={props.value ?? 'null'} readOnly />
            </FormControl>
        );
    return (
        <div className={panelStyle.auth_container}>
            <div className={panelStyle.auth_config_container}>
                <MutableTextBox
                    name="Instance URL"
                    caption="URL of the Salesforce Instance"
                    value={authParams?.instanceUrl.toString() ?? ''}
                    onChange={() => {}}
                />
                <MutableTextBox
                    name="App Consumer Key"
                    caption="Setup > Apps > App Manager > View > Manage Consumer Details"
                    value={authParams?.clientId ?? ''}
                    onChange={() => {}}
                />
                <Button sx={{ marginTop: '28px' }} onClick={connect} disabled={auth.authRequested}>
                    Connect
                </Button>
            </div>
            {auth.authStarted && (
                <div className={panelStyle.auth_info_container}>
                    <div className={panelStyle.auth_info_header}>
                        <div className={panelStyle.userinfo_profile_container}>
                            <img
                                className={panelStyle.userinfo_profile_picture}
                                src={userInfo?.photos?.picture ?? SalesforceDummyAccount}
                            />
                        </div>
                        <div className={panelStyle.userinfo_profile_who}>
                            <div className={panelStyle.userinfo_profile_name}>
                                {userInfo?.name || <Skeleton width={128} height={16} count={1} />}
                            </div>
                            <div className={panelStyle.userinfo_profile_email}>
                                {userInfo?.email || <Skeleton width={256} height={16} count={1} />}
                            </div>
                        </div>
                        <div className={panelStyle.auth_info_actions}>
                            <Button variant="danger" onClick={disconnect}>
                                Disconnect
                            </Button>
                        </div>
                    </div>
                    <div className={panelStyle.auth_info_oauth}>
                        <ImmutableTextBox
                            name="API Instance URL"
                            value={auth.coreAccessToken?.apiInstanceUrl ?? null}
                        />
                        <ImmutableSecretBox
                            name="Core Access Token"
                            value={auth.coreAccessToken?.accessToken ?? null}
                        />
                    </div>
                    <div className={panelStyle.auth_info_dc}>
                        <ImmutableTextBox name="Data Cloud Instance URL" value={auth.dataCloudInstanceUrl} />
                        <ImmutableSecretBox name="Data Cloud Instance URL" value={auth.dataCloudAccessToken} />
                    </div>
                </div>
            )}
            {auth.authError && <div className={panelStyle.auth_error}>{auth.authError}</div>}
        </div>
    );
};

interface SalesforceConnectorPanelProps {
    userAuthParams?: SalesforceAuthParams;
}

export const SalesforceConnectorPanel: React.FC<SalesforceConnectorPanelProps> = (
    props: SalesforceConnectorPanelProps,
) => {
    return (
        <>
            <div className={pageStyle.card_header_container}>
                <div className={pageStyle.platform_logo}>
                    <svg width="28px" height="28px">
                        <use xlinkHref={`${symbols}#salesforce-notext`} />
                    </svg>
                </div>
                <div className={pageStyle.platform_name} id="connector-sf-data-cloud">
                    Salesforce Data Cloud
                </div>
                <div className={pageStyle.platform_info}>
                    <IconButton variant="invisible" icon={InfoIcon} aria-labelledby="connector-sf-data-cloud" />
                </div>
            </div>
            <div className={pageStyle.card_body_container}>
                <SalesforceAuthFlowPanel userAuthParams={props.userAuthParams} />
            </div>
        </>
    );
};
