import * as React from 'react';

import { check, DownloadEvent, Update } from '@tauri-apps/plugin-updater';

import { useLogger } from './logger_provider.js';
import { Result, RESULT_ERROR, RESULT_OK } from '../utils/result.js';
import { Logger } from './logger.js';
import { loadReleaseManifest, ReleaseChannel, ReleaseManifest } from './web_version_check.js';
import { SQLYNX_CANARY_RELEASE_MANIFEST, SQLYNX_STABLE_RELEASE_MANIFEST } from '../globals.js';
import { STABLE_RELEASE_MANIFEST_CTX, STABLE_UPDATE_MANIFEST_CTX, CANARY_RELEASE_MANIFEST_CTX, CANARY_UPDATE_MANIFEST_CTX, VERSION_CHECK_CTX, VersionCheckStatusCode, InstallableUpdate, InstallationStatusSetter, InstallationStatusCode, InstallationState, INSTALLATION_STATUS_CTX } from './version_check.js';

class InstallableTauriUpdate implements InstallableUpdate {
    /// The logger
    logger: Logger;
    /// Update the installation status
    update: Update;
    /// Set the installation status
    setInstallationState: (setter: InstallationStatusSetter) => void;

    constructor(update: Update, setState: (setter: InstallationStatusSetter) => void, logger: Logger) {
        this.logger = logger;
        this.update = update;
        this.setInstallationState = setState;
    }
    /// Download and install
    public async download() {
        try {
            await this.update.downloadAndInstall((progress: DownloadEvent) => {
                switch (progress.event) {
                    case "Started":
                        this.setInstallationState(_ => ({
                            update: this,
                            statusCode: InstallationStatusCode.Started,
                            totalBytes: progress.data.contentLength ?? null,
                            loadedBytes: 0,
                            inProgressBytes: 0,
                            error: null,
                        }));
                        break;
                    case "Progress":
                        this.setInstallationState(s => ({
                            update: this,
                            statusCode: InstallationStatusCode.InProgress,
                            totalBytes: s?.totalBytes ?? 0,
                            loadedBytes: (s?.loadedBytes ?? 0) + (s?.inProgressBytes ?? 0),
                            inProgressBytes: progress.data.chunkLength,
                            error: null,
                        }));
                        break;
                    case "Finished": {
                        this.setInstallationState(s => {
                            const totalBytes = s?.totalBytes ?? 0;
                            return {
                                update: this,
                                statusCode: InstallationStatusCode.RestartPending,
                                totalBytes: totalBytes,
                                loadedBytes: (totalBytes > 0) ? totalBytes : (s?.loadedBytes ?? (s?.inProgressBytes ?? 0)),
                                inProgressBytes: 0,
                                error: null,
                            };
                        });
                        break;
                    }
                }
            });
        } catch (e: unknown) {
            const err = e instanceof Error ? e : new Error(e?.toString());
            this.setInstallationState(s => {
                return {
                    update: this,
                    statusCode: InstallationStatusCode.Failed,
                    totalBytes: s?.totalBytes ?? 0,
                    loadedBytes: s?.loadedBytes ?? 0,
                    inProgressBytes: s?.inProgressBytes ?? 0,
                    error: err,
                };
            });
        }
    }
}

/// Check for updates using the tauri updater
async function checkChannelUpdates(channel: ReleaseChannel, setResult: (result: Result<InstallableTauriUpdate | null>) => void, setInstallationStatus: (setter: InstallationStatusSetter) => void, logger: Logger) {
    const start = performance.now();
    try {
        logger.info(`checking for channel updates`, { "channel": channel }, "version_check");
        const update = await check({
            headers: {
                "sqlynx-channel": channel
            }
        });
        const end = performance.now();
        logger.info(`checking for channel updates succeeded`, { "channel": channel, "duration": Math.floor(end - start).toString() }, "version_check");
        setResult({
            type: RESULT_OK,
            value: update == null ? null : new InstallableTauriUpdate(update, setInstallationStatus, logger),
        });
    } catch (e: any) {
        const err = e instanceof Error ? e : new Error(e?.toString());
        const end = performance.now();
        logger.error(`checking for channel updates failed`, { "channel": channel, "duration": Math.floor(end - start).toString(), "error": e.toString() }, "version_check");
        setResult({
            type: RESULT_ERROR,
            error: new Error(err.toString())
        });
    }
}


type Props = {
    children: React.ReactElement;
};

export const NativeVersionCheck: React.FC<Props> = (props: Props) => {
    const logger = useLogger();

    // It is actually redundant to fetch the dedicated release manifest just for the UI as well.
    // Let's check if we can contribute upstream if `check` can return version information also if there's no newer version available.

    const [stableRelease, setStableRelease] = React.useState<Result<ReleaseManifest> | null>(null);
    const [stableUpdate, setStableUpdate] = React.useState<Result<InstallableTauriUpdate | null> | null>(null);
    const [canaryRelease, setCanaryRelease] = React.useState<Result<ReleaseManifest> | null>(null);
    const [canaryUpdate, setCanaryUpdate] = React.useState<Result<InstallableTauriUpdate | null> | null>(null);
    const [installationStatus, setInstallationStatus] = React.useState<InstallationState | null>(null);

    React.useEffect(() => {
        loadReleaseManifest("stable", SQLYNX_STABLE_RELEASE_MANIFEST, setStableRelease, logger);
        loadReleaseManifest("canary", SQLYNX_CANARY_RELEASE_MANIFEST, setCanaryRelease, logger);
        checkChannelUpdates("stable", setStableUpdate, setInstallationStatus, logger);
        checkChannelUpdates("canary", setCanaryUpdate, setInstallationStatus, logger);
    }, []);


    // Find any updates
    let checkedForUpdates = false;
    const updates: InstallableUpdate[] = [];
    if (stableUpdate != null && stableUpdate.type == RESULT_OK) {
        checkedForUpdates = true;
        if (stableUpdate.value != null) {
            updates.push(stableUpdate.value);
        }
    }
    if (canaryUpdate != null && canaryUpdate.type == RESULT_OK) {
        checkedForUpdates = true;
        if (canaryUpdate.value != null) {
            updates.push(canaryUpdate.value);
        }
    }

    // Derive the version check status
    let status = VersionCheckStatusCode.Unknown;
    if (checkedForUpdates) {
        status = VersionCheckStatusCode.UpToDate;
        if (updates.length > 0) {
            status = VersionCheckStatusCode.UpdateAvailable;
        }
        // TODO consolidate error handling for updates
        for (const update of updates) {
            if (update === installationStatus?.update) {
                switch (installationStatus.statusCode) {
                    case InstallationStatusCode.Started:
                    case InstallationStatusCode.InProgress:
                        status = VersionCheckStatusCode.UpdateInstalling;
                        break;
                    case InstallationStatusCode.RestartPending:
                        status = VersionCheckStatusCode.RestartPending;
                        break;
                    case InstallationStatusCode.Failed:
                        status = VersionCheckStatusCode.UpdateFailed;
                        break;
                }
            }
        }
    }
    return (
        <VERSION_CHECK_CTX.Provider value={status}>
            <INSTALLATION_STATUS_CTX.Provider value={installationStatus}>
                <STABLE_RELEASE_MANIFEST_CTX.Provider value={stableRelease}>
                    <STABLE_UPDATE_MANIFEST_CTX.Provider value={stableUpdate}>
                        <CANARY_RELEASE_MANIFEST_CTX.Provider value={canaryRelease}>
                            <CANARY_UPDATE_MANIFEST_CTX.Provider value={canaryUpdate}>
                                {props.children}
                            </CANARY_UPDATE_MANIFEST_CTX.Provider>
                        </CANARY_RELEASE_MANIFEST_CTX.Provider>
                    </STABLE_UPDATE_MANIFEST_CTX.Provider>
                </STABLE_RELEASE_MANIFEST_CTX.Provider>
            </INSTALLATION_STATUS_CTX.Provider>
        </VERSION_CHECK_CTX.Provider>
    );
};

