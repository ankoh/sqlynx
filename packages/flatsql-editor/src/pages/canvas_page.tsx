import * as React from 'react';
import { ScriptEditor } from '../editor/script_editor';

import styles from './canvas_page.module.css';

interface Props {}

export const CanvasPage: React.FC<Props> = (props: Props) => {
    return (
        <div className={styles.page}>
            <div className={styles.header_container}>FlatSQL Logo</div>
            <div className={styles.editor_section} style={{ height: '66%' }}>
                <div className={styles.editor_card}>
                    <ScriptEditor />
                </div>
            </div>
        </div>
    );
};
