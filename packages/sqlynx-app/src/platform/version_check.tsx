import * as React from 'react';

import { isNativePlatform } from './native_globals.js';
import { NativeVersionCheck } from './native_version_check.js';
import { ReleaseManifest, WebVersionCheck } from './web_version_check.js';
import { Result } from '../utils/result.js';

export enum UpdateStatus {
    Unknown,
    Disabled,
    UpToDate,
    UpdateAvailable
}

export enum InstallationState {
    Started,
    InProgress,
    Finished
}

export interface InstallationStatus {
    state: InstallationState;
    totalBytes: number | null;
    loadedBytes: number;
    inProgressBytes: number;
}

export type InstallationStatusSetter = React.SetStateAction<InstallationStatus | null>;

export interface InstallableUpdate {
    download(): Promise<void>
}

export const UPDATE_STATUS_CTX = React.createContext<UpdateStatus>(UpdateStatus.Unknown);
export const STABLE_RELEASE_MANIFEST_CTX = React.createContext<Result<ReleaseManifest> | null>(null);
export const STABLE_UPDATE_MANIFEST_CTX = React.createContext<Result<InstallableUpdate | null> | null>(null);
export const CANARY_RELEASE_MANIFEST_CTX = React.createContext<Result<ReleaseManifest> | null>(null);
export const CANARY_UPDATE_MANIFEST_CTX = React.createContext<Result<InstallableUpdate | null> | null>(null);

export const useUpdateStatus = () => React.useContext(UPDATE_STATUS_CTX)!;
export const useStableReleaseManifest = () => React.useContext(STABLE_RELEASE_MANIFEST_CTX)!;
export const useStableUpdateManifest = () => React.useContext(STABLE_UPDATE_MANIFEST_CTX)!;
export const useCanaryReleaseManifest = () => React.useContext(CANARY_RELEASE_MANIFEST_CTX)!;
export const useCanaryUpdateManifest = () => React.useContext(CANARY_UPDATE_MANIFEST_CTX)!;

type Props = {
    children: React.ReactElement;
};

export const VersionCheck: React.FC<Props> = (props: Props) => {
    if (isNativePlatform()) {
        return <NativeVersionCheck {...props} />;
    } else {
        return <WebVersionCheck {...props} />;
    }
};
