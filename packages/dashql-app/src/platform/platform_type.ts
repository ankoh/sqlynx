import { isDesktopHost } from './native_globals.js';

export enum PlatformType {
    WEB = 0,
    /// The desktop app, on any operating system
    DESKTOP = 1,
}

/// The platform the app runs on
export const usePlatformType = (): PlatformType => isDesktopHost() ? PlatformType.DESKTOP : PlatformType.WEB;
