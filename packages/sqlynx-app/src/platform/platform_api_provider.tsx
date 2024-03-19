import * as React from 'react';

import { PlatformApi } from './platform_api.js';
import { isNativePlatform, setupNativePlatform } from './native_platform.js';
import { setupWebPlatform } from './web_platform.js';

const PLATFORM_API_CTX = React.createContext<PlatformApi | null>(null);
export const usePlatformApi = () => React.useContext(PLATFORM_API_CTX);

type Props = {
    children: React.ReactElement;
};

export const PlatformApiProvider: React.FC<Props> = (props: Props) => {
    const [api, setApi] = React.useState<PlatformApi | null>(null);
    React.useEffect(() => {
        if (isNativePlatform()) {
            setupNativePlatform(setApi);
        } else {
            setupWebPlatform(setApi);
        }
    }, []);
    return <PLATFORM_API_CTX.Provider value={api}>{props.children}</PLATFORM_API_CTX.Provider>;
};
