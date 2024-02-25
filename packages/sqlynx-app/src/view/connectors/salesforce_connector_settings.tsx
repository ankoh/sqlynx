import * as React from 'react';

import { Button } from '@primer/react';
import { KeyIcon, LogIcon, PlugIcon } from '@primer/octicons-react';

import { useSalesforceAuthState } from '../../connectors/salesforce_auth_state.js';
import { TextField } from '../../view/text_field.js';

import * as symbols from '../../../static/svg/symbols.generated.svg';

import style from './connector_settings.module.css';

interface Props { }

export const SalesforceConnectorSettings: React.FC<Props> = (
    _props: Props,
) => {
    const authState = useSalesforceAuthState();

    return (
        <div className={style.layout}>
            <div className={style.connector_header_container}>
                <div className={style.platform_logo}>
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
                            name="Instance API URL"
                            caption="URL of the Salesforce API"
                            value={authState.coreAccessToken?.apiInstanceUrl ?? ''}
                            onChange={() => { }}
                            placeholder="Instance API"
                            leadingVisual={() => <div>URL</div>}
                            readOnly
                        />
                        <TextField
                            name="Core Access Token"
                            caption="Access Token for Salesforce Core"
                            value={authState.coreAccessToken?.accessToken ?? ''}
                            onChange={() => { }}
                            placeholder="Access Token"
                            leadingVisual={KeyIcon}
                            readOnly
                        />
                        <TextField
                            name="Data Cloud Instance URL"
                            caption="URL of the Data Cloud instance"
                            value={authState.dataCloudAccessToken?.instanceUrl?.toString() ?? ''}
                            onChange={() => { }}
                            placeholder="Data Cloud Instance"
                            leadingVisual={() => <div>URL</div>}
                            readOnly
                        />
                        <TextField
                            name="Data Cloud Access Token"
                            caption="URL of the Data Cloud instance"
                            value={authState.dataCloudAccessToken?.accessToken?.toString() ?? ''}
                            onChange={() => { }}
                            placeholder="Access Token"
                            leadingVisual={KeyIcon}
                            readOnly
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};
