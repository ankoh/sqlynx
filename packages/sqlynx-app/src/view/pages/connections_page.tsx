import * as React from 'react';

import symbols from '../../../static/svg/symbols.generated.svg';
import styles from './connections_page.module.css';

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
                        <button>Test</button>
                    </div>
                </div>
            </div>
        </div>
    );
};
