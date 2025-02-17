import * as React from 'react';

import { useConnectionRegistry } from './connection_registry.js';
import { useCatalogUpdater } from './catalog_loader.js';
import { useLogger } from '../platform/logger_provider.js';

const LOG_CTX = 'catalog_loader';

/// The catalog refresh interval
const CATALOG_REFRESH_AFTER = 60 * 1000;
/// A function to add a connection id to a queue
type QueueCatalogLoaderFn = (connectionId: number) => void;
/// A React context to propagate a catalog loader function
const QUEUE_FN = React.createContext<QueueCatalogLoaderFn | null>(null);

/// Use the catalog loader queue
export function useCatalogLoaderQueue(): QueueCatalogLoaderFn {
    return React.useContext(QUEUE_FN)!;
}

interface CatalogLoaderQueueState {
    /// The pending connection ids
    queued: Set<number>;
}

export function CatalogLoaderQueueProvider(props: { children?: React.ReactElement }) {
    const logger = useLogger();
    const connReg = useConnectionRegistry();
    const update = useCatalogUpdater();

    const [state, setState] = React.useState<CatalogLoaderQueueState>(() => ({ queued: new Set<number>() }));
    const updatesInProgress = React.useRef<Set<number> | null>(null);

    React.useEffect(() => {
        const inProgress = updatesInProgress.current ?? new Set();

        // Helper to perform the catalog update
        const doUpdate = async (cid: number) => {
            inProgress.add(cid);
            try {
                // Otherwise start the catalog update
                const [_updateId, updatePromise] = update(cid, {});
                // Await the update
                await updatePromise;
            } catch (e: any) {
                logger.warn("catalog update failed", {}, LOG_CTX);
            }
            inProgress.delete(cid);
        };

        const processed: number[] = [];
        for (const cid of state.queued) {
            // Already updating?
            if (inProgress.has(cid)) {
                continue;
            }
            // Find the connection
            const connState = connReg.connectionMap.get(cid);
            if (!connState) {
                continue;
            }

            // Has a current catalog update running?
            // Then we skip auto-updates
            if (connState.catalogUpdatesRunning.size > 0) {
                continue;
            }

            // Was there a recent update?
            if (connState.catalogUpdatesFinished.length > 0) {
                const recent = connState.catalogUpdatesFinished[connState.catalogUpdatesFinished.length - 1];
                const now = new Date();
                const elapsed = (recent.finishedAt?.getTime() ?? now.getTime()) - now.getTime();
                if (elapsed < CATALOG_REFRESH_AFTER) {
                    logger.info("skipping catalog update", { "elapsed": elapsed.toString(), "threshold": CATALOG_REFRESH_AFTER.toString() }, LOG_CTX)
                    continue;
                }
            }

            // Perform the catalog update
            doUpdate(cid);
            // Remember that we processed the connection id
            processed.push(cid);
        }

        // Remove all processed ids from the queue
        setState(s => {
            // Remove
            for (const cid of processed) {
                s.queued.delete(cid)
            }
            return { ...s, queued: s.queued };
        });

    }, [state.queued]);

    const queueFn = React.useCallback<QueueCatalogLoaderFn>((cid: number) => {
        setState(s => { s.queued.add(cid); return { ...s } });
    }, [setState]);

    return (
        <QUEUE_FN.Provider value={queueFn}>
            {props.children}
        </QUEUE_FN.Provider>

    );
}
