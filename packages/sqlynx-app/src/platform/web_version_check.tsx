import * as React from 'react';

import { useLogger } from './logger_provider.js';
import { Result, RESULT_ERROR, RESULT_OK } from '../utils/result.js';
import { Logger } from './logger.js';
import { SQLYNX_CANARY_RELEASE_MANIFEST, SQLYNX_STABLE_RELEASE_MANIFEST } from '../globals.js';
import { CANARY_RELEASE_MANIFEST_CTX, CANARY_UPDATE_MANIFEST_CTX, STABLE_RELEASE_MANIFEST_CTX, STABLE_UPDATE_MANIFEST_CTX, UPDATE_STATUS_CTX, UpdateStatus } from './version_check.js';

type Props = {
    children: React.ReactElement;
};

/// A release bundle
export interface ReleaseBundle {
    url: URL;
    signature: string | null;
    name: string;
    bundle_type: string;
    targets: string[];
}

/// A release manifest
export interface ReleaseManifest {
    release_id: string;
    pub_date: Date;
    version: string;
    git_commit_hash: string;
    git_commit_url: string;
    update_manifest_url: string;
    bundles: ReleaseBundle[];
}

function parseReleaseManifest(raw: any): ReleaseManifest {
    if (raw.pub_date) {
        raw.pub_date = new Date(Date.parse(raw.pub_date));
    }
    for (const bundle of raw.bundles) {
        bundle.url = new URL(bundle.url);
    }
    return raw as ReleaseManifest;
}

/// A release channel
export type ReleaseChannel = "stable" | "canary";

/// Load the release manifest
export async function loadReleaseManifest(channel: ReleaseChannel, url: URL, setResult: (result: Result<ReleaseManifest>) => void, logger: Logger) {
    const start = performance.now();
    logger.info(`fetching ${channel} release manifest`, "version_check");
    try {
        // Fetch the release manifest
        const manifestRequest = await fetch(url);
        const manifestRaw = (await manifestRequest.json());
        const manifest = parseReleaseManifest(manifestRaw);
        // Set release manifest
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

    const [stableRelease, setStableRelease] = React.useState<Result<ReleaseManifest> | null>(null);
    const [canaryRelease, setCanaryRelease] = React.useState<Result<ReleaseManifest> | null>(null);

    React.useEffect(() => {
        loadReleaseManifest("stable", SQLYNX_STABLE_RELEASE_MANIFEST, setStableRelease, logger);
        loadReleaseManifest("canary", SQLYNX_CANARY_RELEASE_MANIFEST, setCanaryRelease, logger);
    }, []);

    return (
        <UPDATE_STATUS_CTX.Provider value={UpdateStatus.Disabled}>
            <STABLE_RELEASE_MANIFEST_CTX.Provider value={stableRelease}>
                <STABLE_UPDATE_MANIFEST_CTX.Provider value={null}>
                    <CANARY_RELEASE_MANIFEST_CTX.Provider value={canaryRelease}>
                        <CANARY_UPDATE_MANIFEST_CTX.Provider value={null}>
                            {props.children}
                        </CANARY_UPDATE_MANIFEST_CTX.Provider>
                    </CANARY_RELEASE_MANIFEST_CTX.Provider>
                </STABLE_UPDATE_MANIFEST_CTX.Provider>
            </STABLE_RELEASE_MANIFEST_CTX.Provider>
        </UPDATE_STATUS_CTX.Provider>
    );
};