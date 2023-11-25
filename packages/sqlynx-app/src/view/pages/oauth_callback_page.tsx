import * as React from 'react';

import styles from './oauth_callback_page.module.css';

interface Props {}

export const OAuthCallbackPage: React.FC<Props> = (props: Props) => {
    return <div className={styles.container}>Oauth Callback Page</div>;
};
