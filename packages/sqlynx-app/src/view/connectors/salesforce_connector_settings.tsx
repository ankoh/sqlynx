import * as React from 'react';

import { Button } from '@primer/react';
import { KeyIcon, LogIcon, PlugIcon, TagIcon } from '@primer/octicons-react';

import { useSalesforceAuthState } from '../../connectors/salesforce_auth_state.js';
import { useSalesforceUserInfo } from '../../connectors/salesforce_userinfo_resolver.js';
import { TextField } from '../../view/text_field.js';
import { classNames } from '../../utils/classnames.js';

import * as symbols from '../../../static/svg/symbols.generated.svg';

import style from './connector_settings.module.css';

const DUMMY_ACCOUNT = new URL('../../../static/img/salesforce_account_placeholder.png', import.meta.url);

interface Props { }

export const SalesforceConnectorSettings: React.FC<Props> = (
    _props: Props,
) => {
    const authState = useSalesforceAuthState();
    const isAuthenticated = false;

    const userInfo = useSalesforceUserInfo();

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
                    <Button leadingVisual={LogIcon} count={3}>Logs</Button>
                    <Button leadingVisual={PlugIcon}>Connect</Button>
                </div>
            </div>
            <div className={style.body_container}>
                <div className={style.section}>
                    <div className={style.section_layout}>
                        <TextField
                            name="Instance URL"
                            caption="URL of the Salesforce Instance"
                            value={authState.authParams?.instanceUrl ?? ''}
                            onChange={() => { }}
                            placeholder="Salesforce Instance"
                            leadingVisual={() => <div>URL</div>}
                        />
                        <TextField
                            name="App Consumer Key"
                            caption="Setup > Apps > App Manager > View > Manage Consumer Details"
                            value={authState.authParams?.appConsumerKey ?? ''}
                            onChange={() => { }}
                            placeholder="Consumer Key"
                            leadingVisual={() => <div>ID</div>}
                        />
                    </div>
                </div>
                <div className={style.section}>
                    <div className={style.section_layout}>
                        <TextField
                            name="Client ID"
                            caption="All requests are sent with the header 'x-trace-id: <client-id>/sfdc/<request-id>'"
                            value=""
                            placeholder="client id"
                            leadingVisual={TagIcon}
                            onChange={() => { }}
                            readOnly
                            disabled
                        />
                        <TextField
                            className={style.grid_column_1}
                            name="Instance API URL"
                            caption="URL of the Salesforce API"
                            value={authState.coreAccessToken?.apiInstanceUrl ?? ''}
                            onChange={() => { }}
                            placeholder=""
                            leadingVisual={() => <div>URL</div>}
                            readOnly
                            disabled={!isAuthenticated}
                        />
                        <TextField
                            name="Core Access Token"
                            caption="Access Token for Salesforce Core"
                            value={authState.coreAccessToken?.accessToken ?? ''}
                            onChange={() => { }}
                            placeholder=""
                            leadingVisual={KeyIcon}
                            readOnly
                            disabled={!isAuthenticated}
                        />
                        <TextField
                            name="Data Cloud Instance URL"
                            caption="URL of the Data Cloud instance"
                            value={authState.dataCloudAccessToken?.instanceUrl?.toString() ?? ''}
                            onChange={() => { }}
                            placeholder=""
                            leadingVisual={() => <div>URL</div>}
                            readOnly
                            disabled={!isAuthenticated}
                        />
                        <TextField
                            name="Data Cloud Access Token"
                            caption="URL of the Data Cloud instance"
                            value={authState.dataCloudAccessToken?.accessToken?.toString() ?? ''}
                            onChange={() => { }}
                            placeholder=""
                            leadingVisual={KeyIcon}
                            readOnly
                            disabled={!isAuthenticated}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};
