import * as React from 'react';
import { isNativePlatform } from './native_globals.js';
import { NativeVersionCheck } from './native_version_check.js';
import { WebVersionCheck } from './web_version_check.js';

export enum UpdateStatus {
    Unknown,
    UpToDate,
    UpdateAvailable
}

export const UPDATE_STATUS_CTX = React.createContext<UpdateStatus>(UpdateStatus.Unknown);

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

