import * as React from 'react';

import { isNativePlatform } from './native_globals.js';

type Props = {
    children: React.ReactElement;
};

export enum PlatformType {
    WEB = 0,
    MACOS = 1,
}

const PLATFORM_TYPE_CTX = React.createContext<PlatformType>(PlatformType.WEB);
export const usePlatformType = () => React.useContext(PLATFORM_TYPE_CTX)!;

export const PlatformTypeProvider: React.FC<Props> = (props: Props) => {
    const t = isNativePlatform() ? PlatformType.MACOS : PlatformType.WEB;
    return <PLATFORM_TYPE_CTX.Provider value={t}>{props.children}</PLATFORM_TYPE_CTX.Provider>;
};
