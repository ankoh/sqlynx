import * as React from 'react';
import symbols from '@ankoh/dashql-svg-symbols';
import * as styles from './version_viewer.module.css';

import { SyncIcon, XIcon } from '../foundations/symbol_icon.js';

import { DASHQL_GIT_COMMIT, DASHQL_VERSION } from '../../globals.js';
import {
    InstallableUpdate,
    InstallationStatusCode,
    InstallationState,
    useCanaryReleaseManifest,
    useCanaryUpdateManifest,
    useInstallationStatus,
    useStableReleaseManifest,
    useStableUpdateManifest,
    useVersionCheck,
    useVersionCheckRefresh,
    VersionCheckStatusCode,
} from '../../platform/version/version_check.js';
import { Button, ButtonVariant, IconButton } from '../foundations/button.js';
import { PlatformType, usePlatformType } from '../../platform/platform_type.js';
import { canInstallReleaseVersion, detectReleaseChannel, ReleaseChannel, ReleaseManifest } from '../../platform/version/web_version_check.js';
import { Result, RESULT_ERROR, RESULT_OK } from '../../utils/result.js';
import { IndicatorStatus, StatusIndicator } from '../foundations/status_indicator.js';
import { ReleaseBundles } from './release_bundle.js';
import { AnchoredOverlay } from '../foundations/anchored_overlay.js';
import { AnchorAlignment, AnchorSide } from '../foundations/anchored_position.js';
import { ProgressBar } from '../foundations/progress_bar.js';
import { relaunch } from '../../platform/process.js';
import { useLogger } from '../../platform/logger/logger_provider.js';

const VERSION_CHECK_INTERVAL_MS = 5 * 60 * 1000;

interface UpdateChannelProps {
    channel: ReleaseChannel;
    name: string;
    /// Whether this is the channel the app currently tracks for updates
    isActive: boolean;
    releaseManifest: Result<ReleaseManifest | null> | null;
    updateManifest: Result<InstallableUpdate | null> | null;
    installationStatus: InstallationState | null;
    /// Install an update from this channel. Also persists the channel as the active one.
    onInstall: (channel: ReleaseChannel, update: InstallableUpdate) => void;
}

const UpdateChannel: React.FC<UpdateChannelProps> = (props: UpdateChannelProps) => {
    let versionName: string | null = null;
    let status: React.ReactElement | null = null;

    // Get the latest version from the release manifest
    if (props.releaseManifest?.type === RESULT_OK) {
        if (props.releaseManifest.value != null) {
            versionName = props.releaseManifest.value.version;
        }
    }
    switch (props.updateManifest?.type) {
        case RESULT_OK:
            // Check if there's an installation status.
            // If there is no installation ongoing, we render a download button.
            // If the installation status refers to this channel, we render the installation status instead.
            // If it's not referring to this channel, we render nothing.
            if (props.installationStatus == null) {
                // Same-channel installs only move forward. Switching channels may select an older
                // release, for example when moving from a canary back to stable.
                const isInstallable = versionName != null && canInstallReleaseVersion(versionName, DASHQL_VERSION);
                if (!isInstallable) {
                    status = props.isActive
                        ? <span className={styles.update_channel_action_status}>up to date</span>
                        : null;
                } else if (props.updateManifest.value != null) {
                    // The upgrade is installable, render a button to trigger installation.
                    const installable = props.updateManifest.value;
                    status = <Button onClick={() => props.onInstall(props.channel, installable)}>Install</Button>;
                } else {
                    // The manifest advertises a newer version but no installable update was returned.
                    // update yet (e.g. the check is still in flight or failed). Surface it without an action.
                    status = <span className={styles.update_channel_action_status}>update available</span>;
                }
            } else {
                // Does the current installation refer to this channel?
                if (props.installationStatus.update == props.updateManifest.value) {
                    console.log(props.installationStatus);
                    // Do we know the total bytes already?
                    // Render a query_status bar then.
                    if (props.installationStatus.totalBytes != null && props.installationStatus.totalBytes > 0) {
                        if (props.installationStatus.statusCode == InstallationStatusCode.InProgress) {
                            const progress = props.installationStatus.loadedBytes / props.installationStatus.totalBytes;
                            console.log(progress * 100);
                            status = <ProgressBar className={styles.update_channel_action_progress} progress={progress * 100} />;
                        } else {
                            status = (
                                <StatusIndicator width="16px" height="16px" status={IndicatorStatus.Succeeded} />
                            );
                        }
                    } else {
                        // Otherwise just tell the user we're doing something
                        status = <span>installing</span>
                    }
                } else {
                    // Otherwise render nothing since we're installing a different update
                }
            }
            break;
        case RESULT_ERROR:
            status = <span>{(props.updateManifest.error as Error).message}</span>;
            break;
    }
    return (
        <>
            <div className={styles.update_channel_version}>
                <svg className={styles.update_channel_version_icon} width="16px" height="16px">
                    <use xlinkHref={`${symbols}#package`} />
                </svg>
                <div className={styles.update_channel_version_name}>
                    {versionName}
                </div>
            </div>
            <div className={styles.update_channel_name}>
                {props.name}
            </div>
            <div className={styles.update_channel_action}>
                {status ?? undefined}
            </div>
        </>
    );
}

interface VersionViewerProps {
    onClose: () => void;
    onRefresh: () => void;
}

export const VersionInfo: React.FC<VersionViewerProps> = (props: VersionViewerProps) => {
    const platformType = usePlatformType();
    const isWebPlatform = platformType == PlatformType.WEB;
    const stableReleaseManifest = useStableReleaseManifest();
    const stableUpdateManifest = useStableUpdateManifest();
    const canaryReleaseManifest = useCanaryReleaseManifest();
    const canaryUpdateManifest = useCanaryUpdateManifest();
    const installationStatus = useInstallationStatus();
    const versionCheck = useVersionCheck();
    const logger = useLogger();
    const [relaunching, setRelaunching] = React.useState(false);

    // The channel the app currently tracks. It is fully dictated by the installed version scheme.
    const activeChannel: ReleaseChannel = detectReleaseChannel(DASHQL_VERSION);
    const activeUpdateManifest = activeChannel == "canary" ? canaryUpdateManifest : stableUpdateManifest;

    // Are we on the most recent version of the active channel?
    // A successful update check that yields no update means we're up to date.
    let onLatestVersion: boolean | null = null;
    if (activeUpdateManifest?.type === RESULT_OK) {
        onLatestVersion = activeUpdateManifest.value == null;
    }

    // Install an update. The app restarts on the new version afterwards, so the channel re-derives itself.
    const onInstall = React.useCallback((_channel: ReleaseChannel, update: InstallableUpdate) => {
        update.download().catch((e: unknown) => {
            console.error(e);
        });
    }, []);

    const onRelaunch = React.useCallback(() => {
        if (relaunching) {
            return;
        }
        setRelaunching(true);
        relaunch(logger).catch((e: unknown) => {
            setRelaunching(false);
            console.error(e);
        });
    }, [logger, relaunching]);

    if (versionCheck == VersionCheckStatusCode.RestartPending) {
        return (
            <div className={styles.restart_overlay}>
                <div className={styles.header_container}>
                    <div className={styles.header_left_container}>
                        <div className={styles.title}>Update ready</div>
                    </div>
                    <div className={styles.header_right_container}>
                        <IconButton
                            variant={ButtonVariant.Invisible}
                            aria-label="Close"
                            onClick={props.onClose}
                        >
                            <XIcon />
                        </IconButton>
                    </div>
                </div>
                <div className={styles.restart_body}>
                    <div className={styles.restart_text}>
                        A new version has been installed. Relaunch to apply the update.
                    </div>
                    <Button
                        variant={ButtonVariant.Primary}
                        block
                        disabled={relaunching}
                        onClick={onRelaunch}
                    >
                        {relaunching ? 'Relaunching...' : 'Relaunch'}
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div className={styles.overlay}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.title}>Version</div>
                </div>
                <div className={styles.header_right_container}>
                    <VersionRefreshButton onRefresh={props.onRefresh} />
                    <IconButton
                        variant={ButtonVariant.Invisible}
                        aria-label="Close"
                        onClick={props.onClose}
                    >
                        <XIcon />
                    </IconButton>
                </div>
            </div>
            <div className={styles.version_info_container}>
                <div className={styles.version_info_key}>
                    Current Version
                </div>
                <div className={styles.version_info_value}>
                    <span>{DASHQL_VERSION}</span>
                    {!isWebPlatform && onLatestVersion === true && (
                        <span className={styles.version_info_latest}>latest</span>
                    )}
                </div>
                <div className={styles.version_info_key}>
                    Channel
                </div>
                <div className={styles.version_info_value}>
                    {activeChannel}
                </div>
                <div className={styles.version_info_key}>
                    Git Commit
                </div>
                <div className={styles.version_info_value}>
                    {DASHQL_GIT_COMMIT}
                </div>
            </div>
            {!isWebPlatform && (
                <div className={styles.update_channels_container}>
                    <div className={styles.update_channels_title}>
                        Release Channels
                    </div>
                    <div className={styles.update_channel_list}>
                        <UpdateChannel
                            channel="stable"
                            name="stable"
                            isActive={activeChannel == "stable"}
                            releaseManifest={stableReleaseManifest}
                            updateManifest={stableUpdateManifest}
                            installationStatus={installationStatus}
                            onInstall={onInstall}
                        />
                        <UpdateChannel
                            channel="canary"
                            name="canary"
                            isActive={activeChannel == "canary"}
                            releaseManifest={canaryReleaseManifest}
                            updateManifest={canaryUpdateManifest}
                            installationStatus={installationStatus}
                            onInstall={onInstall}
                        />
                    </div>
                </div>
            )}
            {isWebPlatform && <ReleaseBundles className={styles.release_bundles} />}
        </div>
    );
}

type VersionInfoOverlayProps = {
    isOpen: boolean;
    onOpen?: () => void;
    onClose: () => void;
    renderAnchor: (p: object) => React.ReactElement;
    side?: AnchorSide;
    align?: AnchorAlignment;
    anchorOffset?: number;
}
export function VersionInfoOverlay(props: VersionInfoOverlayProps) {
    const refreshVersionCheck = useVersionCheckRefresh();
    const lastOverlayCheckAt = React.useRef<number | null>(null);
    const refresh = React.useCallback(() => {
        lastOverlayCheckAt.current = Date.now();
        refreshVersionCheck?.refresh();
    }, [refreshVersionCheck?.refresh]);
    React.useEffect(() => {
        if (props.isOpen && refreshVersionCheck != null) {
            const now = Date.now();
            if (lastOverlayCheckAt.current != null && now - lastOverlayCheckAt.current < VERSION_CHECK_INTERVAL_MS) {
                return;
            }
            refresh();
        }
    }, [props.isOpen, refresh]);

    return (
        <AnchoredOverlay
            open={props.isOpen}
            onOpen={props.onOpen}
            onClose={props.onClose}
            renderAnchor={props.renderAnchor}
            side={props.side}
            align={props.align}
            anchorOffset={props.anchorOffset}
        >
            <VersionInfo onClose={props.onClose} onRefresh={refresh} />
        </AnchoredOverlay>
    );
}

function VersionRefreshButton(props: {onRefresh: () => void}) {
    const refreshVersionCheck = useVersionCheckRefresh();
    if (refreshVersionCheck == null) {
        return null;
    }
    return (
        <IconButton
            variant={ButtonVariant.Invisible}
            aria-label={refreshVersionCheck.isRefreshing ? 'Checking for updates' : 'Check for updates'}
            aria-disabled={refreshVersionCheck.isRefreshing}
            onClick={() => {
                if (!refreshVersionCheck.isRefreshing) {
                    props.onRefresh();
                }
            }}
        >
            <span aria-hidden="true">
                {refreshVersionCheck.isRefreshing
                    ? <StatusIndicator width="16px" height="16px" fill="currentColor" status={IndicatorStatus.Running} />
                    : <SyncIcon />}
            </span>
        </IconButton>
    );
}

interface VersionCheckIndicatorProps {
    status: VersionCheckStatusCode;
}

export function VersionCheckIndicator(props: VersionCheckIndicatorProps) {
    switch (props.status) {
        case VersionCheckStatusCode.Unknown:
        case VersionCheckStatusCode.Disabled:
        case VersionCheckStatusCode.UpToDate:
            return (
                <div className={styles.version_check_container}>
                    <div className={styles.version_check_icon}>
                        <svg width="16px" height="16px">
                            <use xlinkHref={`${symbols}#package`} />
                        </svg>
                    </div>
                </div>
            );
        case VersionCheckStatusCode.UpdateAvailable:
            return (
                <div className={styles.version_check_container_with_indicator}>
                    <div className={styles.version_check_icon}>
                        <svg width="16px" height="16px">
                            <use xlinkHref={`${symbols}#package_cut_24`} />
                        </svg>
                    </div>
                    <div className={styles.version_check_indicator}>
                        <svg width="10px" height="10px">
                            <use xlinkHref={`${symbols}#alert_fill_12`} />
                        </svg>
                    </div>
                </div>
            );
        case VersionCheckStatusCode.UpdateInstalling:
            return (
                <div className={styles.version_check_container_with_indicator}>
                    <div className={styles.version_check_icon}>
                        <svg width="16px" height="16px">
                            <use xlinkHref={`${symbols}#package_cut_24`} />
                        </svg>
                    </div>
                    <div className={styles.version_check_indicator}>
                        <svg width="10px" height="10px">
                            <use xlinkHref={`${symbols}#refresh`} />
                        </svg>
                    </div>
                </div>
            );
        case VersionCheckStatusCode.RestartPending:
            return (
                <div className={styles.version_check_container_with_indicator}>
                    <div className={styles.version_check_icon}>
                        <svg width="16px" height="16px">
                            <use xlinkHref={`${symbols}#package_cut_24`} />
                        </svg>
                    </div>
                    <div className={styles.version_check_indicator}>
                        <svg width="10px" height="10px">
                            <use xlinkHref={`${symbols}#rocket_circle_16`} />
                        </svg>
                    </div>
                </div>
            );
        case VersionCheckStatusCode.UpdateFailed:
            return (
                <div className={styles.version_check_container_with_indicator}>
                    <div className={styles.version_check_icon}>
                        <svg width="16px" height="16px">
                            <use xlinkHref={`${symbols}#package_cut_24`} />
                        </svg>
                    </div>
                    <div className={styles.version_check_indicator}>
                        <svg width="10px" height="10px">
                            <use xlinkHref={`${symbols}#x_circle_16`} />
                        </svg>
                    </div>
                </div>
            );
    }
}
