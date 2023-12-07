import * as React from 'react';

import { TextInput, FormControl, Button } from '@primer/react';
import { CopyIcon } from '@primer/octicons-react';

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
    params: SalesforceAuthParams;
    setError: (error: string) => void;
}

const SalesforceAuthFlow: React.FC<SalesforceAuthFlowProps> = (props: SalesforceAuthFlowProps) => {
    const userInfo = useSalesforceUserInfo();
    const authClient = useSalesforceAuthClient();
    const onClick = React.useCallback(() => {
        try {
            authClient.login(props.params);
        } catch (e: any) {
            props.setError(e);
        }
    }, [authClient, props.params]);
    const CopyAction = () => (
        <TextInput.Action
            onClick={() => {
                alert('clear input')
            }}
            icon={CopyIcon}
            aria-label="Clear input"
        />
    );
    const MutableTextBox = (props: { name: string, caption: string }) => (
        <FormControl sx={{marginTop: '8px'}}>
            <FormControl.Label>{props.name}</FormControl.Label>
            <TextInput block trailingAction={CopyAction()} />
            <FormControl.Caption>
                {props.caption}
            </FormControl.Caption>
        </FormControl>
    );
    const ImmutableTextBox = (props: { name: string }) => (
        <FormControl disabled sx={{marginTop: '8px'}}>
            <FormControl.Label>{props.name}</FormControl.Label>
            <TextInput block trailingAction={CopyAction()} />
        </FormControl>
    );
    const ImmutableSecretBox = (props: { name: string }) => (
        <FormControl disabled sx={{marginTop: '8px'}}>
            <FormControl.Label>{props.name}</FormControl.Label>
            <TextInput block type="password" trailingAction={CopyAction()} />
        </FormControl>
    );
    return (
        <div className={panelStyle.auth_container}>
            <div className={panelStyle.auth_config_container}>
                <MutableTextBox name="Instance URL" caption='URL of the Salesforce Instance' />
                <MutableTextBox name="Client ID" caption='Salesforce Setup > Managed Apps > [Your App] > Details' />
                <Button sx={{marginTop: '10px'}} onClick={onClick} disabled={userInfo != null}>Connect</Button>
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
                            <Button variant='danger'>Disconnect</Button>
                        </div>
                    </div>
                    <div className={panelStyle.auth_info_oauth}>
                        <ImmutableTextBox name="API Instance URL" />
                        <ImmutableSecretBox name="Core Access Token" />
                    </div>
                    <div className={panelStyle.auth_info_dc}>
                        <ImmutableTextBox name="Data Cloud Instance URL" />
                        <ImmutableSecretBox name="Data Cloud Access Token" />
                    </div>
                </div>
            )}
        </div>
    );
};

interface SalesforceConnectorPanelProps {
    userAuthParams?: SalesforceAuthParams;
}

export const SalesforceConnectorPanel: React.FC<SalesforceConnectorPanelProps> = (
    props: SalesforceConnectorPanelProps,
) => {
    const appConfig = useAppConfig();
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

    return (
        <>
            <div className={pageStyle.card_header_container}>
                <div className={pageStyle.platform_logo}>
                    <svg width="32px" height="32px">
                        <use xlinkHref={`${symbols}#salesforce-notext`} />
                    </svg>
                </div>
                <div className={pageStyle.platform_name}>Salesforce Data Cloud</div>
            </div>
            <div className={pageStyle.card_body_container}>
                {error ? <div>{error}</div> : <SalesforceAuthFlow params={authParams!} setError={setError} />}
            </div>
        </>
    );
};
