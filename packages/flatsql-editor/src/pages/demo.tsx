import * as React from 'react';
import { Editor } from '../editor/editor';

import styles from './demo.module.css';

interface DemoProps {}

export const DemoPage: React.FC<DemoProps> = (props: DemoProps) => {
    return (
        <div className={styles.page}>
            <div className={styles.editor_section} style={{ height: '66%' }}>
                <div className={styles.editor_card}>
                    <Editor />
                </div>
            </div>
        </div>
    );
};
