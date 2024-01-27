import React from 'react';

export interface ElectronContext {
    platform: string;
}

type Props = {
    children: React.ReactElement;
};

const ELECTRON_CTX = React.createContext<ElectronContext | null>(null);

export const ElectronContextResolver: React.FC<Props> = (props: Props) => {
    const context = React.useMemo<ElectronContext | null>(() => {
        const ctx = (window as any)?.electron ?? null;
        return ctx;
    }, []);
    return <ELECTRON_CTX.Provider value={context}>{props.children}</ELECTRON_CTX.Provider>;
};

export const useElectronContext = () => React.useContext(ELECTRON_CTX);

export function isElectron() {
    return ((window as any)?.electron ?? null) != null;
}
