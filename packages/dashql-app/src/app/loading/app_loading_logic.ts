import * as dashql from '@ankoh/dashql-core';

import { TracedLogger } from '../../platform/logger/logger.js';
import { StorageReader } from '../notebook/persistence/storage_provider.js';
import { AppLoadingProgress, AppLoadingProgressConsumer } from './app_loading_progress.js';
import { SetAttachedDatabaseRegistryAction } from '../notebook/connections/attached_database_registry.js';
import type { AttachedDatabaseState } from '../notebook/connections/attached_database_state.js';
import { Dispatch } from '../../utils/variant.js';
import { SetNotebookScriptsRegistryAction } from '../notebook/scripts/notebook_scripts_registry.js';
import { ProgressCounter } from '../../utils/progress.js';
import { InvalidNotebook } from '../notebook/persistence/notebook_validation.js';
import { AppLoadingStatus } from '../router/app_loading_status.js';
import type { RouteContext } from '../router/router.js';

export function canShowNotebook(route: RouteContext, pauseAfterSetup: boolean): boolean {
    return route.appLoadingStatus === AppLoadingStatus.SETUP_DONE
        && route.notebookId != null
        && (!pauseAfterSetup || route.confirmedFinishedSetup);
}

export interface AppLoadingResult {
    /// Notebooks whose metadata failed validation and were refused a load (keyed by bare UUID).
    invalidNotebooks: Map<string, InvalidNotebook>;
    /// Valid restored notebooks in persisted manifest order.
    restoredNotebookIds: string[];
    /// The restored connections
    restoredConnections: Map<string, AttachedDatabaseState>;
}

export function selectStartupNotebook(
    restoredNotebookIds: readonly string[],
): string | null {
    return restoredNotebookIds[0] ?? null;
}

export async function shouldFinishInitialNavigation(initialInlineSetup: Promise<boolean> | null): Promise<boolean> {
    return initialInlineSetup == null || !await initialInlineSetup;
}

/// Main logic to setup the application
export async function loadApp(logger: TracedLogger, core: dashql.DashQL, storage: StorageReader, resetConnections: Dispatch<SetAttachedDatabaseRegistryAction>, resetNotebookScripts: Dispatch<SetNotebookScriptsRegistryAction>, consumer: AppLoadingProgressConsumer) {
    const traced = logger.childSpan();
    traced.info("Loading application", {}, "app_loading");
    const appLoadStartTime = performance.now();

    let progress: AppLoadingProgress = {
        restoreConnections: new ProgressCounter(),
        restoreCatalogs: new ProgressCounter(),
        restoreNotebookScripts: new ProgressCounter(),
    };
    const partialProgressConsumer = (update: Partial<AppLoadingProgress>) => {
        progress = {
            ...progress,
            ...update
        };
        consumer(progress);
    };

    traced.info("Restoring application state", {}, "app_loading");
    const restoreStartTime = performance.now();

    /// First restore the previous app state
    const state = await storage.restoreAppState(core, partialProgressConsumer);

    const restoreDuration = performance.now() - restoreStartTime;
    traced.info("Restored application state", {
        connections: state.connectionStates.size.toString(),
        notebooks: state.notebookScripts.size.toString(),
        durationMs: restoreDuration.toFixed(2)
    }, "app_loading");

    // Reset the attached database registry
    traced.info("Updating attached database registry", {
        connectionCount: state.connectionStates.size.toString()
    }, "app_loading");
    resetConnections({
        attachedDatabases: state.connectionStates,
        attachedDatabasesByNotebook: state.attachedDatabasesByNotebook,
        attachedDatabasesByType: state.connectionStatesByType,
        attachedDatabasesBySignature: state.connectionSignatures,
    });

    // Reset the notebook scripts registry
    traced.info("Updating notebook scripts registry", {
        notebookCount: state.notebookScripts.size.toString()
    }, "app_loading");
    resetNotebookScripts({
        notebookScriptsMap: state.notebookScripts,
        notebookScriptsByConnection: state.notebookScriptsByConnection,
        notebookScriptsByConnectionType: state.notebookScriptsByConnectionType,
    });

    const totalAppLoadDuration = performance.now() - appLoadStartTime;
    traced.info("Application loading complete", {
        totalDurationMs: totalAppLoadDuration.toFixed(2)
    }, "app_loading");

    return {
        invalidNotebooks: state.invalidNotebooks,
        restoredNotebookIds: [...state.notebookScripts.keys()],
        restoredConnections: state.connectionStates,
    };
}
