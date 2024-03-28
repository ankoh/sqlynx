import * as React from 'react';

import { check, Update } from '@tauri-apps/plugin-updater';

import { useLogger } from './logger_provider.js';
import { Result, RESULT_ERROR, RESULT_OK } from '../utils/result.js';
import { Logger } from './logger.js';
import { loadReleaseManifest, ReleaseChannel, ReleaseManifest } from './web_version_check.js';
import { SQLYNX_CANARY_RELEASE_MANIFEST, SQLYNX_STABLE_RELEASE_MANIFEST } from '../globals.js';

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

    const [_stableRelease, setStableRelease] = React.useState<Result<ReleaseManifest> | null>(null);
    const [_stableUpdate, setStableUpdate] = React.useState<Result<Update | null> | null>(null);
    const [_canaryRelease, setCanaryRelease] = React.useState<Result<ReleaseManifest> | null>(null);
    const [_canaryUpdate, setCanaryUpdate] = React.useState<Result<Update | null> | null>(null);

    React.useEffect(() => {
        loadReleaseManifest("stable", SQLYNX_STABLE_RELEASE_MANIFEST, setStableRelease, logger);
        loadReleaseManifest("canary", SQLYNX_CANARY_RELEASE_MANIFEST, setCanaryRelease, logger);
        checkChannelUpdates("stable", setStableUpdate, logger);
        checkChannelUpdates("canary", setCanaryUpdate, logger);
    }, []);


    return props.children;
};

