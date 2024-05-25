import * as React from 'react';
import { Button } from '@primer/react';
import { PlugIcon } from '@primer/octicons-react';

import * as symbols from '../../../static/svg/symbols.generated.svg';
import * as style from './connector_settings.module.css';

const LOG_CTX = "brainstorm_connector";

export const BrainstormConnectorSettings: React.FC<{}> = (_props: {}) => {
    return (
        <div className={style.layout}>
            <div className={style.connector_header_container}>
                <div className={style.platform_logo}>
                    <svg width="28px" height="28px">
                        <use xlinkHref={`${symbols}#zap`} />
                    </svg>
                </div>
                <div className={style.platform_name} aria-labelledby="connector-brainstorm">
                    Brainstorm
                </div>
            </div >
            <div className={style.body_container}>
                <div />
            </div>
        </ div>
    );
};
