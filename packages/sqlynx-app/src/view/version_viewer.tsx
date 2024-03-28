import * as React from 'react';
import { createPortal } from 'react-dom';
import { DownloadIcon, XIcon } from '@primer/octicons-react';
import { Button, IconButton } from '@primer/react';
import { motion } from "framer-motion"
import { SQLYNX_GIT_COMMIT, SQLYNX_VERSION } from '../globals.js';
import { check } from '@tauri-apps/plugin-updater'

import * as symbols from '../../static/svg/symbols.generated.svg';

// import { useLogger } from '../platform/logger_provider';

import styles from './version_viewer.module.css';

interface VersionViewerProps {
    onClose: () => void;
}

export const VersionViewer: React.FC<VersionViewerProps> = (props: VersionViewerProps) => {
    // const logger = useLogger();

    return (
        <div className={styles.overlay}>
            <motion.div
                className={styles.overlay_background}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.4 }}
                onClick={props.onClose}
            />
            <motion.div
                className={styles.overlay_card}
                initial={{ translateY: "20px" }}
                animate={{ translateY: 0 }}
                transition={{ duration: 0.2 }}
            >
                <div className={styles.header_container}>
                    <div className={styles.header_left_container}>
                        <div className={styles.title}>Version</div>
                    </div>
                    <div className={styles.header_right_container}>
                        <IconButton
                            variant="invisible"
                            icon={XIcon}
                            aria-label="close-overlay"
                            onClick={props.onClose}
                        />
                    </div>
                </div>
                <div className={styles.version_info_container}>
                    <div className={styles.version_info_key}>
                        Current Version
                    </div>
                    <div className={styles.version_info_value}>
                        {SQLYNX_VERSION}
                    </div>
                    <div className={styles.version_info_key}>
                        Git Commit
                    </div>
                    <div className={styles.version_info_value}>
                        {SQLYNX_GIT_COMMIT}
                    </div>
                </div>
                <div className={styles.release_channels_container}>
                    <div className={styles.release_channels_title}>
                        Release Channels
                    </div>
                    <div className={styles.release_channel_list}>
                        <>
                            <div className={styles.release_channel_name}>
                                Stable
                            </div>
                            <div className={styles.release_channel_version}>
                                <svg className={styles.release_channel_version_icon} width="16px" height="16px">
                                    <use xlinkHref={`${symbols}#package`} />
                                </svg>
                                <div className={styles.release_channel_version_name}>
                                    v0.0.3
                                </div>
                            </div>
                            <div className={styles.release_channel_action}>
                                <span className={styles.release_channel_action_status_disabled}>
                                    Version is older
                                </span>
                            </div>
                        </>
                        <>
                            <div className={styles.release_channel_name}>
                                Canary
                            </div>
                            <div className={styles.release_channel_version}>
                                <svg className={styles.release_channel_version_icon} width="16px" height="16px">
                                    <use xlinkHref={`${symbols}#package`} />
                                </svg>
                                <div className={styles.release_channel_version_name}>
                                    v0.0.4-dev.123
                                </div>
                            </div>
                            <div className={styles.release_channel_action}>
                                <Button>Install</Button>
                            </div>
                        </>
                    </div>
                </div>
            </motion.div>
        </div>
    );
}

const element = document.getElementById('root');

export const VersionViewerInPortal = (props: VersionViewerProps) => createPortal(<VersionViewer {...props} />, element!);
