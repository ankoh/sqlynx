import * as React from 'react';

import symbols from '../../../static/svg/symbols.generated.svg';
import styles from './connections_page.module.css';
import { useSalesforceAuth } from '../../auth/salesforce_auth';

interface SalesforceConnectionCardProps {}

export const SalesforceConnectionCard: React.FC<SalesforceConnectionCardProps> = (
    props: SalesforceConnectionCardProps,
) => {
    const { login } = useSalesforceAuth();

    const onClick = React.useCallback(() => {
        login({
            oauthRedirect: new URL('http://localhost:9002/oauth2/callback'),
            instanceUrl: new URL('https://trialorgfarmforu-16f.test2.my.pc-rnd.salesforce.com'),
            clientId: '3MVG9GS4BiwvuHvgBoJxvy6gBq99_Ptg8FHx1QqO0bcDgy3lYc3x1b3nLPXGDQzYlYYMOwqo_j12QdTgAvAZD',
        });
    }, []);

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
                <button onClick={onClick}>Test</button>
            </div>
        </div>
    );
};

interface Props {}

export const ConnectionsPage: React.FC<Props> = (props: Props) => {
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
