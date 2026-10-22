import { ProgressCounter } from "../../utils/progress.js";

export type AppLoadingPartialProgressConsumer = (progress: Partial<AppLoadingProgress>) => void;
export type AppLoadingProgressConsumer = (progress: AppLoadingProgress) => void;

export interface AppLoadingProgress {
    /// Restore the connections
    restoreConnections: ProgressCounter;
    /// Restore the catalogs
    restoreCatalogs: ProgressCounter;
    /// Restore the session scripts
    restoreSessionScripts: ProgressCounter;
}
