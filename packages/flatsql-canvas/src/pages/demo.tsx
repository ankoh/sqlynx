import * as React from 'react';
import { Editor } from '../editor/editor';

import styles from './demo.module.css';

interface DemoProps {}

export const DemoPage: React.FC<DemoProps> = (props: DemoProps) => {
    return (
        <div className={styles.container}>
            <div className={styles.page}>
                <div className={styles.header}>
                    FlatSQL Editor
                </div>
                <div className={styles.editor}>
                    <Editor />
                </div>
            </div>
        </div>
    );
}