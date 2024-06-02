import * as React from 'react';

import * as symbols from '../../../static/svg/symbols.generated.svg';
import * as baseStyle from './connector_settings.module.css';

interface Props { }

export const ServerlessSettings: React.FC<Props> = (_props: Props) => {
    return (
        <div className={baseStyle.layout}>
            <div className={baseStyle.connector_header_container}>
                <div className={baseStyle.platform_logo}>
                    <svg width="24px" height="24px">
                        <use xlinkHref={`${symbols}#folder`} />
                    </svg>
                </div>
                <div className={baseStyle.platform_name} aria-labelledby="connector-files">
                    Serverless
                </div>
            </div >
            <div className={baseStyle.body_container}>
                <div className={baseStyle.section} />
            </div>
        </ div>
    );
};
