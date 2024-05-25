import * as React from 'react';
import { Button } from '@primer/react';

import { classNames } from '../utils/classnames.js';
import { ReleaseChannel, ReleaseManifest } from '../platform/web_version_check.js';
import { useLogger } from '../platform/logger_provider.js';
import { useCanaryReleaseManifest, useStableReleaseManifest } from '../platform/version_check.js';

import * as styles from './release_bundle.module.css';
import { Result, RESULT_OK } from '../utils/index.js';

interface ReleaseBundleProps {
    name: string;
    channel: ReleaseChannel;
    pubDate: Date;
    url: URL;
    version: string;
}
const ReleaseBundle: React.FC<ReleaseBundleProps> = (props: ReleaseBundleProps) => {
    const logger = useLogger();
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
                <Button onClick={() => {
                    logger.info(`prompting user to download ${props.name} ${props.version}`);
                    const link = document.createElement('a');
                    link.href = props.url.toString();
                    link.download = props.name;
                    link.click();
                }}>Download</Button>
            </div>
        </React.Fragment>
    );
}

interface ReleaseBundlesProps {
    className?: string;
}

export const ReleaseBundles: React.FC<ReleaseBundlesProps> = (props: ReleaseBundlesProps) => {
    const stableReleaseManifest = useStableReleaseManifest();
    const canaryReleaseManifest = useCanaryReleaseManifest();

    // We'll care about identifying the exact platform bundles as soon as we support more than mac.
    const macBundles: ReleaseBundleProps[] = React.useMemo(() => {
        const macBundles: ReleaseBundleProps[] = []
        const releaseManifests: [Result<ReleaseManifest> | null, ReleaseChannel][] = [[stableReleaseManifest, "stable"], [canaryReleaseManifest, "canary"]];
        for (const [manifest, channel] of releaseManifests) {
            if (manifest != null && manifest.type == RESULT_OK) {
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
        <div className={classNames(styles.native_apps_container, props.className)}>
            <div className={styles.native_app_platform_title}>
                Native Apps
            </div>
            <div className={styles.native_app_platform_bundles}>
                {macBundles.map((bundle, index) => (
                    <ReleaseBundle key={index} {...bundle} />
                ))}
            </div>
        </div>
    );
}

