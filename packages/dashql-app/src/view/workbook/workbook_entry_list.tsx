import * as React from 'react';

import * as styles from './workbook_entry_list.module.css';

import { WorkbookState } from "workbook/workbook_state.js";

interface Props {
    workbook: WorkbookState | null;
}

export function WorkbookEntryList(props: Props) {
    if (props.workbook == null) {
        return <div />;
    }

    return (
        <div className={styles.entry_list}>
            <div className={styles.entry_container}>
                <div className={styles.entry_key_container}>
                    <div className={styles.entry_key_name}>
                        1
                    </div>
                </div>
            </div>
            <div className={styles.entry_container}>
                <div className={styles.entry_key_container}>
                    <div className={styles.entry_key_name}>
                        2
                    </div>
                </div>
            </div>
        </div>
    );
}
