export enum AppHost {
    WEB = 'web',
    ELECTRON = 'electron',
}

export function getAppHost(): AppHost {
    if ('dashqlElectron' in globalThis) return AppHost.ELECTRON;
    return AppHost.WEB;
}

export function isDesktopHost(): boolean {
    return getAppHost() !== AppHost.WEB;
}

