import * as React from 'react';


import * as styles from './shell_page.module.css';

interface PageProps { }

export const ShellPage: React.FC<PageProps> = (_props: PageProps) => {
    return (
        <div className={styles.page}>
        </div>
    );
};
