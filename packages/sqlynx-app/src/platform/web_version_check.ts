import * as React from 'react';

import { useLogger } from './logger_provider.js';
import { Result, RESULT_ERROR, RESULT_OK } from '../utils/result.js';
import { Logger } from './logger.js';
import { SQLYNX_CANARY_RELEASE_MANIFEST, SQLYNX_STABLE_RELEASE_MANIFEST } from '../globals.js';

type Props = {
    children: React.ReactElement;
};

export interface ReleaseManifest { }

export type ReleaseChannel = "stable" | "canary";

/// Load the release manifest
export async function loadReleaseManifest(channel: ReleaseChannel, url: URL, setResult: (result: Result<ReleaseManifest>) => void, logger: Logger) {
    const start = performance.now();
    logger.info(`fetching ${channel} release manifest`, "version_check");
    try {
        const manifestRequest = await fetch(url);
        const manifest = (await manifestRequest.json()) as ReleaseManifest;
        const end = performance.now();
        logger.info(`fetched ${channel} release manifest in ${Math.floor(end - start)} ms`, "version_check");
        setResult({
            type: RESULT_OK,
            value: manifest
        });
        console.log(manifest);
    } catch (e: any) {
        const end = performance.now();
        logger.error(`failed to fetch ${channel} release manifest after ${Math.floor(end - start)} ms: ${e.toString()}`, "version_check");
        setResult({
            type: RESULT_ERROR,
            error: new Error(e.toString())
        });
    }
}

export const WebVersionCheck: React.FC<Props> = (props: Props) => {
    const logger = useLogger();

    const [_stableRelease, setStableRelease] = React.useState<Result<ReleaseManifest> | null>(null);
    const [_canaryRelease, setCanaryRelease] = React.useState<Result<ReleaseManifest> | null>(null);

    React.useEffect(() => {
        loadReleaseManifest("stable", SQLYNX_STABLE_RELEASE_MANIFEST, setStableRelease, logger);
        loadReleaseManifest("canary", SQLYNX_CANARY_RELEASE_MANIFEST, setCanaryRelease, logger);
    }, []);

    return props.children;
};
