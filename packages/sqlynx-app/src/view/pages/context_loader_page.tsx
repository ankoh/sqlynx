import * as React from 'react';

import styles from './context_loader_page.module.css';

import symbols from '../../../static/svg/symbols.generated.svg';

interface Props {}

export const ContextLoaderPage: React.FC<Props> = (props: Props) => {
    return (
        <div className={styles.page}>
            <div className={styles.content_container}>
                <div className={styles.banner_container}>
                    <div className={styles.banner_logo}>
                        <svg width="30px" height="30px">
                            <use xlinkHref={`${symbols}#sqlynx`} />
                        </svg>
                    </div>
                    <div className={styles.banner_title}>SQLynx</div>
                </div>
                <div className={styles.url_info}>
                    <div className={styles.url_box}></div>
                    <div className={styles.url_details}>
                        <div className={styles.url_detail_main_script}></div>
                        <div className={styles.urL_detail_schema_script}></div>
                        <div className={styles.url_detail_connector_type}></div>
                        <div className={styles.url_detail_connector_params}></div>
                    </div>
                </div>
                <div className={styles.context_content}>
                    <div className={styles.context_content_tabs}>Tabs</div>
                    <div className={styles.context_content_body}>Body</div>
                </div>
                <div className={styles.loading_status}></div>
            </div>
        </div>
    );
};
