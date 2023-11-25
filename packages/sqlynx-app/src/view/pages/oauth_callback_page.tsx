import * as React from 'react';

import { useSearchParams } from 'react-router-dom';

import styles from './oauth_callback_page.module.css';

interface Props {}

export const OAuthCallbackPage: React.FC<Props> = (props: Props) => {
    const [searchParams, _setSearchParams] = useSearchParams();
    const flatParams = new Map();
    for (const [key, value] of searchParams.entries()) {
        flatParams.set(key, value);
    }
    console.log(flatParams);
    return <div className={styles.container}>Oauth Callback Page</div>;
};
