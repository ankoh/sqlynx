import * as React from 'react';
import { createPortal } from 'react-dom';
import { motion } from "framer-motion"
import { Update } from '@tauri-apps/plugin-updater';
import { XIcon } from '@primer/octicons-react';
import { Button, IconButton } from '@primer/react';

import { SQLYNX_GIT_COMMIT, SQLYNX_VERSION } from '../globals.js';
import { useCanaryReleaseManifest, useCanaryUpdateManifest, useStableReleaseManifest, useStableUpdateManifest } from '../platform/version_check.js';
import { PlatformType, usePlatformType } from '../platform/platform_type.js';
import { ReleaseChannel, ReleaseManifest } from '../platform/web_version_check.js';
import { RESULT_OK, Result } from '../utils/result.js';

import * as symbols from '../../static/svg/symbols.generated.svg';

import styles from './version_viewer.module.css';

interface UpdateChannelProps {
    name: string;
    releaseManifest: Result<ReleaseManifest | null> | null;
    updateManifest: Result<Update | null> | null;
}

const UpdateChannel: React.FC<UpdateChannelProps> = (props: UpdateChannelProps) => {
    let version = null;
    if (props.releaseManifest?.type === RESULT_OK) {
        if (props.releaseManifest.value != null) {
            version = props.releaseManifest.value.version;
        }
    }
    let hasUpdate = false;
    if (props.updateManifest?.type === RESULT_OK) {
        if (props.updateManifest.value != null) {
            hasUpdate = true;
        }
    }
    return (
        <>
            <div className={styles.update_channel_version}>
                <svg className={styles.update_channel_version_icon} width="16px" height="16px">
                    <use xlinkHref={`${symbols}#package`} />
                </svg>
                <div className={styles.update_channel_version_name}>
                    {version}
                </div>
            </div>
            <div className={styles.update_channel_name}>
                {props.name}
            </div>
            <div className={styles.update_channel_action}>
                {hasUpdate ? <Button>Install</Button> : <span>Version is older</span>}
            </div>
        </>
    );
}

interface ReleaseBundleProps {
    name: string;
    channel: ReleaseChannel;
    pubDate: Date;
    url: URL;
    version: string;
}

const ReleaseBundle: React.FC<ReleaseBundleProps> = (props: ReleaseBundleProps) => {
    return (
        <React.Fragment>
            <div className={styles.native_app_platform_bundle_name}>
                {props.name}
            </div>
            <div className={styles.native_app_platform_bundle_version}>
                {props.version}
            </div>
            <div className={styles.native_app_platform_bundle_channel}>
                <div className={styles.native_app_platform_bundle_channel_text}>
                    {props.channel}
                </div>
            </div>
            <div className={styles.native_app_platform_bundle_download}>
                <Button>Download</Button>
            </div>
        </React.Fragment>
    );
}

interface VersionViewerProps {
    onClose: () => void;
}

export const VersionViewer: React.FC<VersionViewerProps> = (props: VersionViewerProps) => {
    const platformType = usePlatformType();
    const isWebPlatform = platformType == PlatformType.WEB;
    const stableReleaseManifest = useStableReleaseManifest();
    const stableUpdateManifest = useStableUpdateManifest();
    const canaryReleaseManifest = useCanaryReleaseManifest();
    const canaryUpdateManifest = useCanaryUpdateManifest();

    // We'll care about identifying the exact platform bundles as soon as we support more than mac.
    const macBundles: ReleaseBundleProps[] = React.useMemo(() => {
        const macBundles: ReleaseBundleProps[] = []
        const releaseManifests: [Result<ReleaseManifest>, ReleaseChannel][] = [[stableReleaseManifest, "stable"], [canaryReleaseManifest, "canary"]];
        for (const [manifest, channel] of releaseManifests) {
            if (manifest.type == RESULT_OK) {
                for (const bundle of manifest.value.bundles) {
                    if (bundle.bundle_type == "Dmg") {
                        macBundles.push({
                            name: bundle.name,
                            channel: channel,
                            pubDate: manifest.value.pub_date,
                            url: bundle.url,
                            version: manifest.value.version
                        });
                    }
                }
            }
        }
        return macBundles;
    }, [stableReleaseManifest, canaryReleaseManifest]);

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
                {!isWebPlatform && (
                    <div className={styles.update_channels_container}>
                        <div className={styles.update_channels_title}>
                            Release Channels
                        </div>
                        <div className={styles.update_channel_list}>
                            <UpdateChannel
                                name="stable"
                                releaseManifest={stableReleaseManifest}
                                updateManifest={stableUpdateManifest}
                            />
                            <UpdateChannel
                                name="canary"
                                releaseManifest={canaryReleaseManifest}
                                updateManifest={canaryUpdateManifest}
                            />
                        </div>
                    </div>
                )}
                {isWebPlatform && (
                    <div className={styles.native_apps_container}>
                        <>
                            <div className={styles.native_app_platform_title}>
                                Native Apps
                            </div>
                            <div className={styles.native_app_platform_bundles}>
                                {macBundles.map((bundle, index) => (
                                    <ReleaseBundle key={index} {...bundle} />
                                ))}
                            </div>
                        </>
                    </div>
                )}
            </motion.div>
        </div>
    );
}

const element = document.getElementById('root');

export const VersionViewerInPortal = (props: VersionViewerProps) => createPortal(<VersionViewer {...props} />, element!);