import * as React from 'react';

import * as symbols from '../../../static/svg/symbols.generated.svg';
import * as style from './connector_settings.module.css';
import { classNames } from '../../utils/classnames.js';

const LOG_CTX = "files_connector";

export const FileConnectorSettings: React.FC<{}> = (_props: {}) => {
    return (
        <div className={style.layout}>
            <div className={style.connector_header_container}>
                <div className={style.platform_logo}>
                    <svg width="24px" height="24px">
                        <use xlinkHref={`${symbols}#folder`} />
                    </svg>
                </div>
                <div className={style.platform_name} aria-labelledby="connector-files">
                    Files
                </div>
            </div >
            <div className={style.body_container}>
                <div className={style.section}>
                    <div className={classNames(style.section_layout, style.body_section_layout)}>
                    </div>
                </div>
            </div>
        </ div>
    );
};
