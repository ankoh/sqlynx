import * as React from 'react';

import { TextInput, FormControl, Button, IconButton } from '@primer/react';
import { CopyIcon, InfoIcon } from '@primer/octicons-react';

import { useAppConfig } from '../../state/app_config';
import { SalesforceAuthParams, useSalesforceAuthClient } from '../../connectors/salesforce_auth_client';
import { useSalesforceUserInfo } from '../../connectors/salesforce_userinfo';

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

const SalesforceAuthFlow: React.FC<SalesforceAuthFlowProps> = (props: SalesforceAuthFlowProps) => {
    const appConfig = useAppConfig();
    const userInfo = useSalesforceUserInfo();
    const authClient = useSalesforceAuthClient();
    const [error, setError] = React.useState<string | null>(null);

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

    const onClick = React.useCallback(() => {
        if (!authParams) {
            // XXX setError not configured
            return;
        }
        try {
            authClient.login(authParams!);
        } catch (e: any) {
            setError(e);
        }
    }, [authClient, authParams]);
    const CopyAction = () => (
        <TextInput.Action
            onClick={() => {
                alert('clear input');
            }}
            icon={CopyIcon}
            aria-label="Clear input"
        />
    );
    const MutableTextBox = (props: { name: string; caption: string; value: string }) => (
        <FormControl sx={{ marginTop: '8px' }}>
            <FormControl.Label>{props.name}</FormControl.Label>
            <TextInput block trailingAction={CopyAction()} value={props.value} />
            <FormControl.Caption>{props.caption}</FormControl.Caption>
        </FormControl>
    );
    const ImmutableTextBox = (props: { name: string; value: string }) => (
        <FormControl disabled sx={{ marginTop: '8px' }}>
            <FormControl.Label>{props.name}</FormControl.Label>
            <TextInput block trailingAction={CopyAction()} />
        </FormControl>
    );
    const ImmutableSecretBox = (props: { name: string; value: string }) => (
        <FormControl disabled sx={{ marginTop: '8px' }}>
            <FormControl.Label>{props.name}</FormControl.Label>
            <TextInput block type="password" trailingAction={CopyAction()} />
        </FormControl>
    );
    return (
        <div className={panelStyle.auth_container}>
            <div className={panelStyle.auth_config_container}>
                <MutableTextBox
                    name="Instance URL"
                    caption="URL of the Salesforce Instance"
                    value={authParams?.instanceUrl.toString() ?? ''}
                />
                <MutableTextBox
                    name="App Consumer Key"
                    caption="Setup > Apps > App Manager > View > Manage Consumer Details"
                    value={authParams?.clientId ?? ''}
                />
                <Button sx={{ marginTop: '28px' }} onClick={onClick} disabled={userInfo != null}>
                    Connect
                </Button>
            </div>
            {userInfo && (
                <div className={panelStyle.auth_info_container}>
                    <div className={panelStyle.auth_info_header}>
                        <div className={panelStyle.userinfo_profile_container}>
                            <img
                                className={panelStyle.userinfo_profile_picture}
                                src={userInfo.photos!.picture ?? SalesforceDummyAccount}
                            />
                        </div>
                        <div className={panelStyle.userinfo_profile_who}>
                            <div className={panelStyle.userinfo_profile_name}>{userInfo.name}</div>
                            <div className={panelStyle.userinfo_profile_email}>{userInfo.email}</div>
                        </div>
                        <div className={panelStyle.auth_info_actions}>
                            <Button variant="danger">Disconnect</Button>
                        </div>
                    </div>
                    <div className={panelStyle.auth_info_oauth}>
                        <ImmutableTextBox name="API Instance URL" value="" />
                        <ImmutableSecretBox name="Core Access Token" value="" />
                    </div>
                    <div className={panelStyle.auth_info_dc}>
                        <ImmutableTextBox name="Data Cloud Instance URL" value="" />
                        <ImmutableSecretBox name="Data Cloud Access Token" value="" />
                    </div>
                </div>
            )}
            {error && <div>{error}</div>}
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
                <div className={pageStyle.platform_name}>Salesforce Data Cloud</div>
                <div className={pageStyle.platform_info}>
                    <IconButton variant="invisible" icon={InfoIcon} aria-labelledby="info" />
                </div>
            </div>
            <div className={pageStyle.card_body_container}>
                <SalesforceAuthFlow userAuthParams={props.userAuthParams} />
            </div>
        </>
    );
};
