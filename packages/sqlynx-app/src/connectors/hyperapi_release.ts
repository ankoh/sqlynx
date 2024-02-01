export interface HyperApiVersion {
    branch: number;
    major: number;
    minor: number;
    revision: string;
}

export enum HyperApiPlatform {
    Windows = 'windows',
    MacOS = 'macos',
    Linux = 'linux',
    Docs = 'docs',
}
export enum HyperApiTarget {
    Python = 'python',
    Cxx = 'cxx',
    Java = 'java',
    DotNet = 'dotnet',
}

type HyperApiArtifacts = {
    [platform: string]: {
        [artifact: string]: string;
    };
};

export interface HyperApiConfig {
    version: HyperApiVersion;
    artifactBaseUrl: string;
    artifactPaths: HyperApiArtifacts;
    artifacts: HyperApiArtifacts;
}

export function loadReleaseInfo(config: Omit<HyperApiConfig, 'artifacts'>): HyperApiConfig {
    const release: HyperApiConfig = {
        ...config,
        artifacts: {},
    };
    const v = config.version;
    const vShort = `${v.branch}.${v.major}.${v.minor}`;
    const vLong = `${v.branch}.${v.major}.${v.minor}.${v.revision}`;

    for (const platform in config.artifactPaths) {
        const paths = config.artifactPaths[platform];
        const out: { [artifact: string]: string } = {};
        for (const target in paths) {
            let template = paths[target];
            template = template.replace('{{VERSION_SHORT}}', vShort);
            template = template.replace('{{VERSION_LONG}}', vLong);
            out[target] = `${config.artifactBaseUrl}${template}`;
        }
        release.artifacts[platform] = out;
    }
    return release;
}
