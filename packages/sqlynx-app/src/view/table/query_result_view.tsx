import * as React from 'react';
import * as styles from './query_result_view.module.css';

interface Props {

}

export function QueryResultView(props: Props) {
    return (
        <div className={styles.root}>
            <div className={styles.header_bar}>
                <div className={styles.header_title}>
                    Query Result
                </div>
            </div>
            <div className={styles.data_container}>
            </div>
            <div className={styles.result_info_container}>

            </div>
        </div>
    );
}