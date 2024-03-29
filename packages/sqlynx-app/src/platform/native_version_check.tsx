import * as React from 'react';

import { check, Update } from '@tauri-apps/plugin-updater';

import { useLogger } from './logger_provider.js';
import { Result, RESULT_ERROR, RESULT_OK } from '../utils/result.js';
import { Logger } from './logger.js';
import { loadReleaseManifest, ReleaseChannel, ReleaseManifest } from './web_version_check.js';
import { SQLYNX_CANARY_RELEASE_MANIFEST, SQLYNX_STABLE_RELEASE_MANIFEST } from '../globals.js';
import { STABLE_RELEASE_MANIFEST_CTX, STABLE_UPDATE_MANIFEST_CTX, CANARY_RELEASE_MANIFEST_CTX, CANARY_UPDATE_MANIFEST_CTX, UPDATE_STATUS_CTX, UpdateStatus } from './version_check.js';

type Props = {
    children: React.ReactElement;
};

/// Check for updates using the tauri updater
async function checkChannelUpdates(channel: ReleaseChannel, setResult: (result: Result<Update | null>) => void, logger: Logger) {
    const start = performance.now();
    try {
        logger.info(`checking for ${channel} updates`, "version_check");
        const update = await check({
            headers: {
                "sqlynx-channel": channel
            }
        });
        const end = performance.now();
        logger.info(`checking for ${channel} updates succeeded in ${end - start} ms`, "version_check");
        setResult({
            type: RESULT_OK,
            value: update
        });
        console.log(update);
    } catch (e: any) {
        const end = performance.now();
        logger.error(`checking for ${channel} updates failed after ${end - start} ms with error: ${e.toString()}`, "version_check");
        setResult({
            type: RESULT_ERROR,
            error: new Error(e.toString())
        });
    }
}

export const NativeVersionCheck: React.FC<Props> = (props: Props) => {
    const logger = useLogger();

    // It is actually redundant to fetch the dedicated release manifest just for the UI as well.
    // Let's check if we can contribute upstream if `check` can return version information also if there's no newer version available.

    const [stableRelease, setStableRelease] = React.useState<Result<ReleaseManifest> | null>(null);
    const [stableUpdate, setStableUpdate] = React.useState<Result<Update | null> | null>(null);
    const [canaryRelease, setCanaryRelease] = React.useState<Result<ReleaseManifest> | null>(null);
    const [canaryUpdate, setCanaryUpdate] = React.useState<Result<Update | null> | null>(null);

    React.useEffect(() => {
        loadReleaseManifest("stable", SQLYNX_STABLE_RELEASE_MANIFEST, setStableRelease, logger);
        loadReleaseManifest("canary", SQLYNX_CANARY_RELEASE_MANIFEST, setCanaryRelease, logger);
        checkChannelUpdates("stable", setStableUpdate, logger);
        checkChannelUpdates("canary", setCanaryUpdate, logger);
    }, []);

    let updateFetched = false;
    let updateAvailable = false;
    if (stableUpdate != null && stableUpdate.type == RESULT_OK) {
        updateFetched = true;
        updateAvailable ||= stableUpdate.value != null;
    }
    if (canaryUpdate != null && canaryUpdate.type == RESULT_OK) {
        updateFetched = true;
        updateAvailable ||= canaryUpdate.value != null;
    }
    let status = UpdateStatus.Unknown;
    if (updateFetched) {
        if (updateAvailable) {
            status = UpdateStatus.UpdateAvailable;
        } else {
            status = UpdateStatus.UpToDate;
        }
    }
    return (
        <UPDATE_STATUS_CTX.Provider value={status}>
            <STABLE_RELEASE_MANIFEST_CTX.Provider value={stableRelease}>
                <STABLE_UPDATE_MANIFEST_CTX.Provider value={stableUpdate}>
                    <CANARY_RELEASE_MANIFEST_CTX.Provider value={canaryRelease}>
                        <CANARY_UPDATE_MANIFEST_CTX.Provider value={canaryUpdate}>
                            {props.children}
                        </CANARY_UPDATE_MANIFEST_CTX.Provider>
                    </CANARY_RELEASE_MANIFEST_CTX.Provider>
                </STABLE_UPDATE_MANIFEST_CTX.Provider>
            </STABLE_RELEASE_MANIFEST_CTX.Provider>
        </UPDATE_STATUS_CTX.Provider>
    );
};
