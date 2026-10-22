import * as dashql from '@ankoh/dashql-core';

import { TracedLogger } from '../../platform/logger/logger.js';
import { StorageReader } from '../session/persistence/storage_provider.js';
import { AppLoadingProgress, AppLoadingProgressConsumer } from './app_loading_progress.js';
import { SetAttachedDatabaseRegistryAction } from '../session/connections/attached_database_registry.js';
import type { AttachedDatabaseState } from '../session/connections/attached_database_state.js';
import { Dispatch } from '../../utils/variant.js';
import { SetSessionScriptsRegistryAction } from '../session/scripts/session_scripts_registry.js';
import { ProgressCounter } from '../../utils/progress.js';
import { InvalidSession } from '../session/persistence/session_validation.js';
import { AppLoadingStatus } from '../router/app_loading_status.js';
import type { RouteContext } from '../router/router.js';

export function canShowSession(route: RouteContext, pauseAfterSetup: boolean): boolean {
    return route.appLoadingStatus === AppLoadingStatus.SETUP_DONE
        && route.sessionId != null
        && (!pauseAfterSetup || route.confirmedFinishedSetup);
}

export interface AppLoadingResult {
    /// Sessions whose metadata failed validation and were refused a load (keyed by bare UUID).
    invalidSessions: Map<string, InvalidSession>;
    /// Valid restored sessions in persisted manifest order.
    restoredSessionIds: string[];
    /// The restored connections
    restoredConnections: Map<string, AttachedDatabaseState>;
}

export function selectStartupSession(
    restoredSessionIds: readonly string[],
): string | null {
    return restoredSessionIds[0] ?? null;
}

export async function shouldFinishInitialNavigation(initialInlineSetup: Promise<boolean> | null): Promise<boolean> {
    return initialInlineSetup == null || !await initialInlineSetup;
}

/// Main logic to setup the application
export async function loadApp(logger: TracedLogger, core: dashql.DashQL, storage: StorageReader, resetConnections: Dispatch<SetAttachedDatabaseRegistryAction>, resetSessionScripts: Dispatch<SetSessionScriptsRegistryAction>, consumer: AppLoadingProgressConsumer) {
    const traced = logger.childSpan();
    traced.info("Loading application", {}, "app_loading");
    const appLoadStartTime = performance.now();

    let progress: AppLoadingProgress = {
        restoreConnections: new ProgressCounter(),
        restoreCatalogs: new ProgressCounter(),
        restoreSessionScripts: new ProgressCounter(),
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
        sessions: state.sessionScripts.size.toString(),
        durationMs: restoreDuration.toFixed(2)
    }, "app_loading");

    // Reset the attached database registry
    traced.info("Updating attached database registry", {
        connectionCount: state.connectionStates.size.toString()
    }, "app_loading");
    resetConnections({
        attachedDatabases: state.connectionStates,
        attachedDatabasesBySession: state.attachedDatabasesBySession,
        attachedDatabasesByType: state.connectionStatesByType,
        attachedDatabasesBySignature: state.connectionSignatures,
    });

    // Reset the session scripts registry
    traced.info("Updating session scripts registry", {
        sessionCount: state.sessionScripts.size.toString()
    }, "app_loading");
    resetSessionScripts({
        sessionScriptsMap: state.sessionScripts,
        sessionScriptsByConnection: state.sessionScriptsByConnection,
        sessionScriptsByConnectionType: state.sessionScriptsByConnectionType,
    });

    const totalAppLoadDuration = performance.now() - appLoadStartTime;
    traced.info("Application loading complete", {
        totalDurationMs: totalAppLoadDuration.toFixed(2)
    }, "app_loading");

    return {
        invalidSessions: state.invalidSessions,
        restoredSessionIds: [...state.sessionScripts.keys()],
        restoredConnections: state.connectionStates,
    };
}
