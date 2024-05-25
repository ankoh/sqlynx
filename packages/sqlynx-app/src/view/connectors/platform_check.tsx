import * as React from 'react';

import { CONNECTOR_INFOS, ConnectorType, requiresSwitchingToNative } from '../../connectors/connector_info.js';
import { ReleaseBundles } from '../release_bundle.js';

import * as styles from './platform_check.module.css';
import * as icons from '../../../static/svg/symbols.generated.svg';

export const PlatformCheck: React.FC<{ connectorType: ConnectorType, children: React.ReactElement }> = (props) => {
    const info = CONNECTOR_INFOS[props.connectorType];
    if (requiresSwitchingToNative(info)) {
        return (
            <div className={styles.root}>
                <div className={styles.container}>
                    <div className={styles.title}>Unsupported platform</div>
                    <div className={styles.description}>
                        This connector can only be used in the native app.<br />
                        cf.
                        <svg className={styles.github_link_icon} width="20px" height="20px">
                            <use xlinkHref={`${icons}#github`} />
                        </svg>
                        &nbsp;
                        <a className={styles.github_link_text} href="https://github.com/ankoh/sqlynx/issues/738" target="_blank">
                            Web connectors for Hyper and Data Cloud
                        </a>
                    </div>
                    <div className={styles.release_bundles}>
                        <ReleaseBundles />
                    </div>
                </div>
            </div>
        );
    } else {
        return props.children;
    }
};
