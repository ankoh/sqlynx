import { Logger } from './logger/logger.js';

/// Relaunch the app, the desktop app installs a downloaded update on the way
export async function relaunch(logger: Logger): Promise<void> {
    logger.info("Relaunching", {});
    if (globalThis.dashqlElectron !== undefined) {
        await globalThis.dashqlElectron.updates.install();
        return;
    }
    window.location.reload();
}
