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

export interface HyperApiReleaseInfo {
    version: HyperApiVersion;
    artifactBaseUrl: string;
    artifacts: HyperApiArtifacts;
}

export function instantiateHyperApiReleaseInfo(release: HyperApiReleaseInfo) {
    const v = release.version;
    const vShort = `${v.branch}.${v.major}.${v.minor}`;
    const vLong = `${v.branch}.${v.major}.${v.minor}.${v.revision}`;

    for (const platform in release.artifacts) {
        const artifacts = release.artifacts[platform];
        for (const target in artifacts) {
            let template = artifacts[target];
            template = template.replace('{{VERSION_SHORT}}', vShort);
            template = template.replace('{{VERSION_LONG}}', vLong);
            artifacts[target] = `${release.artifactBaseUrl}${template}`;
        }
    }
}
