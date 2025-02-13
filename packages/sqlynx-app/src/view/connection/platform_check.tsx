import * as React from 'react';

import { CONNECTOR_INFOS, ConnectorType, requiresSwitchingToNative } from '../../connection/connector_info.js';

import * as styles from './platform_check.module.css';
import * as icons from '../../../static/svg/symbols.generated.svg';
import { VersionInfoOverlay } from '../version_viewer.js';
import { AnchorAlignment, AnchorSide } from '../foundations/anchored_position.js';
import { Button, ButtonVariant } from '../foundations/button.js';
import { PackageIcon } from '@primer/octicons-react';

export const PlatformCheck: React.FC<{ connectorType: ConnectorType, children: React.ReactElement }> = (props) => {
    const [showVersionOverlay, setShowVersionOverlay] = React.useState<boolean>(false);
    const info = CONNECTOR_INFOS[props.connectorType];
    if (requiresSwitchingToNative(info)) {
        return (
            <div className={styles.root}>
                <div className={styles.container}>
                    <div className={styles.title}>Unsupported Platform</div>
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
                    <div className={styles.actions}>
                        <VersionInfoOverlay
                            isOpen={showVersionOverlay}
                            onClose={() => setShowVersionOverlay(false)}
                            renderAnchor={(p: object) => (
                                <Button
                                    className={styles.download_button}
                                    {...p}
                                    variant={ButtonVariant.Default}
                                    onClick={() => setShowVersionOverlay(true)}
                                    leadingVisual={PackageIcon}>
                                    Download App
                                </Button>
                            )}
                            side={AnchorSide.OutsideTop}
                            align={AnchorAlignment.Start}
                            anchorOffset={8}
                        />
                    </div>
                </div>
            </div>
        );
    } else {
        return props.children;
    }
};
