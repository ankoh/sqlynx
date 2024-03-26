import * as React from 'react';

import { PlatformApi } from './platform_api.js';
import { setupNativePlatform } from './native_platform.js';
import { setupWebPlatform } from './web_platform.js';
import { isNativePlatform } from './native_globals.js';
import { LogBuffer } from './log_buffer.js';

const PLATFORM_API_CTX = React.createContext<PlatformApi | null>(null);
export const usePlatformApi = () => React.useContext(PLATFORM_API_CTX);

type Props = {
    children: React.ReactElement;
};

export const PlatformApiProvider: React.FC<Props> = (props: Props) => {
    const logBuffer = React.useMemo<LogBuffer>(() => new LogBuffer(), []);
    const [platform, setPlatform] = React.useState<PlatformApi | null>(null);
    React.useEffect(() => {
        const init = async () => {
            let p: PlatformApi | null;
            if (isNativePlatform()) {
                p = await setupNativePlatform(logBuffer);
            } else {
                p = await setupWebPlatform(logBuffer);
            }
            setPlatform(p);
        };
        init();
    }, []);
    return <PLATFORM_API_CTX.Provider value={platform}>{props.children}</PLATFORM_API_CTX.Provider>;
};
