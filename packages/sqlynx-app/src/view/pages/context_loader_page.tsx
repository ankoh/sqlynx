import * as React from 'react';

import styles from './context_loader_page.module.css';

import symbols from '../../../static/svg/symbols.generated.svg';

interface Props {}

export const ContextLoaderPage: React.FC<Props> = (props: Props) => {
    return (
        <div>
            <svg width="30px" height="30px">
                <use xlinkHref={`${symbols}#sqlynx`} />
            </svg>
        </div>
    );
};
