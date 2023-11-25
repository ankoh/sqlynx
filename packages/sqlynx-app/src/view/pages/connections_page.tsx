import * as React from 'react';

import symbols from '../../../static/svg/symbols.generated.svg';
import styles from './connections_page.module.css';

interface SalesforceConnectionCardProps {}

export const SalesforceConnectionCard: React.FC<SalesforceConnectionCardProps> = (
    props: SalesforceConnectionCardProps,
) => {
    const connectClick = (e: React.MouseEvent<HTMLButtonElement>) => {
        const title = `WINDOW TITLE`;
        const instance_url = `https://trialorgfarmforu-16f.test2.my.pc-rnd.salesforce.com`;
        const client_id = `3MVG9GS4BiwvuHvgBoJxvy6gBq99_Ptg8FHx1QqO0bcDgy3lYc3x1b3nLPXGDQzYlYYMOwqo_j12QdTgAvAZD`;
        const redirect_uri = `http://localhost:9002/oauth2/callback`;
        const response_type = `code`;
        const code_challenge = `XXXXXX`;
        const url = `${instance_url}/services/oauth2/authorize?client_id=${client_id}&redirect_uri=${redirect_uri}&response_type=${response_type}&code_challenge=${code_challenge}`;
        console.log(url);
        const _popup = window.open(url, title, `width=500px,height=400px,left=80px,top=80px`);
    };

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
                <button onClick={connectClick}>Test</button>
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
