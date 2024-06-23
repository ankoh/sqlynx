import * as React from 'react';

import { isNativePlatform } from './native_globals.js';
import { NativeVersionCheck } from './native_version_check.js';
import { ReleaseManifest, WebVersionCheck } from './web_version_check.js';
import { Result } from '../utils/result.js';

export enum VersionCheckStatus {
    Unknown = 0,
    Disabled = 1,
    UpToDate = 2,
    UpdateAvailable = 3,
    UpdateInstalling = 4,
    RestartPending = 5,
    UpdateFailed = 6,
}

export enum InstallationState {
    Started,
    InProgress,
    Finished
}

export interface InstallationStatus {
    update: InstallableUpdate;
    state: InstallationState;
    totalBytes: number | null;
    loadedBytes: number;
    inProgressBytes: number;
}

export type InstallationStatusSetter = React.SetStateAction<InstallationStatus | null>;

export interface InstallableUpdate {
    download(): Promise<void>
}

export const VERSION_CHECK_CTX = React.createContext<VersionCheckStatus>(VersionCheckStatus.Unknown);
export const INSTALLATION_STATUS_CTX = React.createContext<InstallationStatus | null>(null);
export const STABLE_RELEASE_MANIFEST_CTX = React.createContext<Result<ReleaseManifest> | null>(null);
export const STABLE_UPDATE_MANIFEST_CTX = React.createContext<Result<InstallableUpdate | null> | null>(null);
export const CANARY_RELEASE_MANIFEST_CTX = React.createContext<Result<ReleaseManifest> | null>(null);
export const CANARY_UPDATE_MANIFEST_CTX = React.createContext<Result<InstallableUpdate | null> | null>(null);

export const useVersionCheck = () => React.useContext(VERSION_CHECK_CTX)!;
export const useInstallationStatus = () => React.useContext(INSTALLATION_STATUS_CTX);
export const useStableReleaseManifest = () => React.useContext(STABLE_RELEASE_MANIFEST_CTX);
export const useStableUpdateManifest = () => React.useContext(STABLE_UPDATE_MANIFEST_CTX);
export const useCanaryReleaseManifest = () => React.useContext(CANARY_RELEASE_MANIFEST_CTX);
export const useCanaryUpdateManifest = () => React.useContext(CANARY_UPDATE_MANIFEST_CTX);

interface VersionCheckProps {
    children: React.ReactElement;
}

export const VersionCheck: React.FC<VersionCheckProps> = (props: VersionCheckProps) => {
    if (isNativePlatform()) {
        return <NativeVersionCheck {...props} />;
    } else {
        return <WebVersionCheck {...props} />;
    }
};
