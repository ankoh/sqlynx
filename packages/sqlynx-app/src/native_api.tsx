import * as React from 'react';

/// The native api exposed to the PWA
export interface NativeApi {
    os: string;
}

/// The globals provided by tauri
interface TauriGlobals {
    core: {
        convertFileSrc: (path: string, scheme: string) => string;
        invoke: (command: string) => any;
    }
}

/// Initialize the native api, if we're running in a Tauri app
const setupNativeApi = async (setApi: (api: NativeApi) => void) => {
    const tauri = (window as any).__TAURI__ as TauriGlobals;

    // Not running in tauri? (e.g. regular web app?)
    // Silently stop.
    if (tauri === undefined) {
        return;
    }
    console.log(tauri);

    // Test command call
    const os = await tauri.core.invoke("sqlynx_get_os");
    console.log(os);
    // Test streaming call via custom scheme
    const path = tauri.core.convertFileSrc("foo", "sqlynx-native");
    const response = await fetch(path);
    console.log(await response.text());

    // Build the api client
    setApi({
        os
    });
};

/// Expose the native api through a context.
/// In the browser, this context will just be null
const NATIVE_API_CTX = React.createContext<NativeApi | null>(null);
export const useNativeApi = () => React.useContext(NATIVE_API_CTX);

type Props = {
    children: React.ReactElement;
};

export const NativeApiProvider: React.FC<Props> = (props: Props) => {
    const [api, setApi] = React.useState<NativeApi | null>(null);
    React.useEffect(() => {
        setupNativeApi(setApi);
    }, []);
    return <NATIVE_API_CTX.Provider value={api}>{props.children}</NATIVE_API_CTX.Provider>;
};
