import * as React from 'react';

import { TextInput, FormControl, Button, IconButton } from '@primer/react';
import { CopyIcon, InfoIcon } from '@primer/octicons-react';

import { useAppConfig } from '../../app_config';
import { useSalesforceUserInfo } from '../../connectors/salesforce_userinfo_resolver';
import {
    SalesforceAuthParams,
    useSalesforceAuthState,
    useSalesforceAuthFlow,
    CONNECT,
    DISCONNECT,
    CONFIGURE,
} from '../../connectors/salesforce_auth_state';
import { Skeleton } from '../../view/skeleton';

import SalesforceDummyAccount from '../../../static/img/salesforce_account_placeholder.png';

import symbols from '../../../static/svg/symbols.generated.svg';

import panelStyle from './salesforce_connector_panel.module.css';
import pageStyle from '../pages/connections_page.module.css';

interface SalesforceAuthFlowProps {}

const SalesforceAuthFlowPanel: React.FC<SalesforceAuthFlowProps> = (props: SalesforceAuthFlowProps) => {
    const appConfig = useAppConfig();
    const authState = useSalesforceAuthState();
    const authFlow = useSalesforceAuthFlow();
    const userInfo = useSalesforceUserInfo();

    // Initialize auth parameters, if missing
    React.useEffect(() => {
        if (authState.authParams != null) return;
        const defaultApp = appConfig.value?.connectors?.salesforce?.defaultApp;
        if (defaultApp) {
            authFlow({ type: CONFIGURE, value: defaultApp });
        }
    }, [authState.authParams, appConfig.value]);

    const connect = React.useCallback(() => {
        if (authState.authParams) {
            authFlow({ type: CONNECT, value: authState.authParams });
        }
    }, [authFlow, authState.authParams]);
    const disconnect = React.useCallback(() => authFlow({ type: DISCONNECT, value: null }), [authFlow]);

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
            <FormControl>
                <FormControl.Label>{props.name}</FormControl.Label>
                <TextInput block trailingAction={CopyAction()} value={props.value ?? 'null'} readOnly />
            </FormControl>
        );
    const ImmutableSecretBox = (props: { name: string; value: string | null }) =>
        props.value == null ? (
            <LoadingTextBox name={props.name} />
        ) : (
            <FormControl>
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
                    value={authState.authParams?.instanceUrl ?? ''}
                    onChange={() => {}}
                />
                <MutableTextBox
                    name="App Consumer Key"
                    caption="Setup > Apps > App Manager > View > Manage Consumer Details"
                    value={authState.authParams?.clientId ?? ''}
                    onChange={() => {}}
                />
                <Button sx={{ marginTop: '28px' }} onClick={connect} disabled={authState.authRequested}>
                    Connect
                </Button>
            </div>
            {authState.authStarted && (
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
                            value={authState.coreAccessToken?.apiInstanceUrl ?? null}
                        />
                        <ImmutableSecretBox
                            name="Core Access Token"
                            value={authState.coreAccessToken?.accessToken ?? null}
                        />
                    </div>
                    <div className={panelStyle.auth_info_dc}>
                        <ImmutableTextBox
                            name="Data Cloud Instance URL"
                            value={authState.dataCloudAccessToken?.instanceUrl?.toString() ?? null}
                        />
                        <ImmutableSecretBox
                            name="Data Cloud Access Token"
                            value={authState.dataCloudAccessToken?.accessToken?.toString() ?? null}
                        />
                    </div>
                </div>
            )}
            {authState.authError && <div className={panelStyle.auth_error}>{authState.authError}</div>}
        </div>
    );
};

interface SalesforceConnectorPanelProps {}

export const SalesforceConnectorPanel: React.FC<SalesforceConnectorPanelProps> = (
    _props: SalesforceConnectorPanelProps,
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
                <SalesforceAuthFlowPanel />
            </div>
        </>
    );
};
