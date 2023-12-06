import * as React from 'react';

import { useAppConfig } from '../../state/app_config';
import { SalesforceAuthParams, useSalesforceAuthClient } from '../../connectors/salesforce_auth_client';
import { useSalesforceUserInfo } from '../../connectors/salesforce_userinfo';
import { SalesforceUserInformation } from '../../connectors/salesforce_api_client';

import symbols from '../../../static/svg/symbols.generated.svg';
import styles from './connections_page.module.css';

interface SalesforceAuthFlowProps {
    userAuthParams?: SalesforceAuthParams;
}

const ERROR_MISSING_OAUTH_REDIRECT = new Error('missing Salesforce OAuth redirect URL');
const ERROR_MISSING_INSTANCE_URL = new Error('missing Salesforce instance URL');
const ERROR_MISSING_CLIENT_ID = new Error('missing Salesforce client id');
const ERROR_MISSING_OAUTH_CONFIG = new Error('missing Salesforce OAuth config');

const SalesforceAuthFlow: React.FC<SalesforceAuthFlowProps> = (props: SalesforceAuthFlowProps) => {
    const appConfig = useAppConfig();
    const authClient = useSalesforceAuthClient();
    const [authError, setAuthError] = React.useState<Error | null>(null);

    // Select auth parameters
    const authParams = React.useMemo(() => {
        let authParams: SalesforceAuthParams | null = null;
        if (props.userAuthParams !== undefined) {
            authParams = props.userAuthParams;
        } else {
            const connectorConfig = appConfig.value?.connectors?.salesforce;
            if (connectorConfig !== undefined) {
                if (!connectorConfig.oauthRedirect) {
                    setAuthError(e => ERROR_MISSING_OAUTH_REDIRECT);
                } else if (!connectorConfig.instanceUrl) {
                    setAuthError(ERROR_MISSING_INSTANCE_URL);
                } else if (!connectorConfig.clientId) {
                    setAuthError(ERROR_MISSING_CLIENT_ID);
                } else {
                    authParams = {
                        oauthRedirect: new URL(connectorConfig.oauthRedirect),
                        instanceUrl: new URL(connectorConfig.instanceUrl),
                        clientId: connectorConfig.clientId,
                        clientSecret: connectorConfig.clientSecret ?? null,
                    };
                }
            } else {
                setAuthError(ERROR_MISSING_OAUTH_CONFIG);
            }
        }
        return authParams;
    }, [props.userAuthParams, appConfig]);

    // Authentication handler
    const onClick = React.useCallback(() => {
        // AuthParams are always set here
        if (authParams) {
            authClient.login(authParams!);
        }
    }, [appConfig.value, authParams]);

    if (authError != null) {
        return <div>{authError.message}</div>;
    }
    if (!authParams) {
        return <div />;
    } else {
        return <button onClick={onClick}>Test</button>;
    }
};

interface SalesforceUserInfoProps {
    userInfo: SalesforceUserInformation;
}

const SalesforceUserInfo: React.FC<SalesforceUserInfoProps> = (props: SalesforceUserInfoProps) => {
    return <div>{props.userInfo.email}</div>;
};

interface ConnectionCardProps {}

export const SalesforceConnectionCard: React.FC<ConnectionCardProps> = (props: ConnectionCardProps) => {
    const appConfig = useAppConfig();
    const userInfo = useSalesforceUserInfo();
    return (
        <div className={styles.card_container}>
            <div className={styles.card_header_container}>
                <div className={styles.platform_logo}>
                    <svg width="32px" height="32px">
                        <use xlinkHref={`${symbols}#salesforce-notext`} />
                    </svg>
                </div>
                <div className={styles.platform_name}>Salesforce Data Cloud</div>
            </div>
            <div className={styles.card_body_container}>
                {userInfo && appConfig ? <SalesforceUserInfo userInfo={userInfo} /> : <SalesforceAuthFlow />}
            </div>
        </div>
    );
};

interface PageProps {}

export const ConnectionsPage: React.FC<PageProps> = (props: PageProps) => {
    return (
        <div className={styles.page}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.page_title}>Connections</div>
                </div>
            </div>
            <div className={styles.body_container}>
                <SalesforceConnectionCard />
            </div>
        </div>
    );
};
