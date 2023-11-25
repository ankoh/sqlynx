import * as React from 'react';

import { useSearchParams } from 'react-router-dom';

import styles from './oauth_callback_page.module.css';

interface Props {}

export const OAuthCallbackPage: React.FC<Props> = (props: Props) => {
    const [searchParams, _setSearchParams] = useSearchParams();
    return (
        <div className={styles.container}>
            {[...searchParams.entries()].map(([key, value]) => {
                return (
                    <div>
                        {key}: {value}
                    </div>
                );
            })}
        </div>
    );
};
