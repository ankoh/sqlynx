import * as React from 'react';

import { Button } from '@primer/react';
import { KeyIcon, PlugIcon, TagIcon } from '@primer/octicons-react';

import { AUTHORIZE, useSalesforceAuthFlow, useSalesforceAuthState } from '../../connectors/salesforce_auth_state.js';
import { TextField, TextFieldValidationStatus, VALIDATION_ERROR, VALIDATION_UNKNOWN } from '../../view/text_field.js';
import { classNames } from '../../utils/classnames.js';

import * as symbols from '../../../static/svg/symbols.generated.svg';

import style from './connector_settings.module.css';

interface Props { }

export const SalesforceConnectorSettings: React.FC<Props> = (
    _props: Props,
) => {
    const authState = useSalesforceAuthState();
    const authFlow = useSalesforceAuthFlow();
    const isAuthenticated = false;

    const [instanceUrl, setInstanceUrl] = React.useState<string>("");
    const [appConsumerKey, setAppConsumerKey] = React.useState<string>("");
    const [appConsumerSecret, _setAppConsumerSecret] = React.useState<string | null>(null);

    const [instanceUrlValidation, setInstanceUrlValidation] = React.useState<TextFieldValidationStatus>({
        type: VALIDATION_UNKNOWN,
        value: null
    });
    const [appConsumerValidation, setAppConsumerValidation] = React.useState<TextFieldValidationStatus>({
        type: VALIDATION_UNKNOWN,
        value: null
    });
    const startAuth = () => {
        let validationSucceeded = true;
        if (instanceUrl === "") {
            validationSucceeded = false;
            setInstanceUrlValidation({
                type: VALIDATION_ERROR,
                value: "Instance URL cannot be empty"
            });
        }
        if (appConsumerKey === "") {
            validationSucceeded = false;
            setAppConsumerValidation({
                type: VALIDATION_ERROR,
                value: "Connected App cannot be empty"
            });
        }
        if (validationSucceeded) {
            authFlow({
                type: AUTHORIZE,
                value: {
                    instanceUrl: instanceUrl!,
                    appConsumerKey: appConsumerKey!,
                    appConsumerSecret,
                }
            });
        }
    };

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
            <div className={style.body_container}>
                <div className={style.section}>
                    <div className={style.section_layout}>
                        <TextField
                            name="Salesforce Instance URL"
                            caption="URL of the Salesforce Instance"
                            value={instanceUrl}
                            onChange={(e) => setInstanceUrl(e.target.value)}
                            placeholder="Salesforce Instance"
                            leadingVisual={() => <div>URL</div>}
                            validation={instanceUrlValidation}
                        />
                        <TextField
                            name="Connected App"
                            caption="Setup > Apps > App Manager > View > Manage Consumer Details"
                            value={appConsumerKey}
                            onChange={(e) => setAppConsumerKey(e.target.value)}
                            placeholder="Consumer Key"
                            leadingVisual={() => <div>ID</div>}
                            validation={appConsumerValidation}
                        />
                    </div>
                </div>
                <div className={style.section}>
                    <div className={style.section_layout}>
                        <TextField
                            name="Client ID"
                            caption="All requests are sent with the header 'x-trace-id: sqlynx/<client-id>/sfdc/<request-id>'"
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
