import * as React from 'react';

import { useDynamicConnectionDispatch } from './connection_registry.js';
import { CatalogUpdateTaskState, CatalogUpdateTaskStatus } from './catalog_update_state.js';
import { useSalesforceAPI } from './salesforce/salesforce_connector.js';
import { DEMO_CONNECTOR, HYPER_GRPC_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR, SERVERLESS_CONNECTOR, TRINO_CONNECTOR } from './connector_info.js';
import {
    CATALOG_UPDATE_CANCELLED,
    CATALOG_UPDATE_FAILED,
    CATALOG_UPDATE_SUCCEEDED,
    UPDATE_CATALOG,
} from './connection_state.js';
import { updateSalesforceCatalog } from './salesforce/salesforce_catalog_update.js';
import { updateHyperCatalog } from './hyper/hyper_catalog_update.js';
import { useQueryExecutor } from './query_executor.js';
import { updateTrinoCatalog } from './trino/trino_catalog_update.js';
import { useLogger } from '../platform/logger_provider.js';

const LOG_CTX = 'catalog_loader';

const CATALOG_REFRESH_AFTER = 60 * 1000;
let NEXT_CATALOG_UPDATE_ID = 1;

/// The catalog update args
interface CatalogLoaderArgs { }
/// The catalog updater function
export type CatalogLoader = (connectionId: number, args: CatalogLoaderArgs) => [number, Promise<void>];
/// A function to add a connection id to a catalog loader queue
type CatalogLoaderQueueFn = (connectionId: number) => void;
/// A catalog loader queue
interface CatalogLoaderQueue { queue: Set<number>; }

/// The React context to resolve the active catalog loader
const LOADER_CTX = React.createContext<CatalogLoader | null>(null);
/// The React context to propagate a active catalog loader queue function
const LOADER_QUEUE_FN_CTX = React.createContext<CatalogLoaderQueueFn | null>(null);

/// The hook to resolve the catalog updater
export const useCatalogLoader = () => React.useContext(LOADER_CTX)!;
/// The hook to resolve the catalog queue
export const useCatalogLoaderQueueFn = () => React.useContext(LOADER_QUEUE_FN_CTX)!;

export function CatalogLoaderProvider(props: { children?: React.ReactElement }) {
    const logger = useLogger();
    const executor = useQueryExecutor();
    const sfapi = useSalesforceAPI();

    // The connection registry changes frequently, the connection map is stable.
    // This executor will depend on the map directly since it can resolve everything ad-hoc.
    const [connReg, connDispatch] = useDynamicConnectionDispatch();
    const connMap = connReg.connectionMap;

    // Execute a query with pre-allocated query id
    const updateImpl = React.useCallback(async (connectionId: number, _args: CatalogLoaderArgs, updateId: number): Promise<void> => {
        // Check if we know the connection id.
        const conn = connMap.get(connectionId);
        if (!conn) {
            logger.error("failed to resolve connection", { "connection": connectionId.toString() }, LOG_CTX);
            throw new Error(`couldn't find a connection with id ${connectionId}`);
        }
        if (!executor) {
            logger.error("query executor is not configured", { "connection": connectionId.toString() }, LOG_CTX);
            throw new Error(`couldn't find trino executor`);
        }

        logger.debug("updating catalog", { "connection": connectionId.toString() }, LOG_CTX);

        // Accept the query and clear the request
        const abortController = new AbortController();
        const initialState: CatalogUpdateTaskState = {
            taskId: updateId,
            status: CatalogUpdateTaskStatus.STARTED,
            cancellation: abortController,
            error: null,
            startedAt: new Date(),
            finishedAt: null
        };
        connDispatch(connectionId, {
            type: UPDATE_CATALOG,
            value: [updateId, initialState],
        });

        // Update the catalog
        try {
            // Start the query
            switch (conn.details.type) {
                case SALESFORCE_DATA_CLOUD_CONNECTOR:
                    await updateSalesforceCatalog(conn.details.value, conn.catalog, sfapi, abortController);
                    break;
                case HYPER_GRPC_CONNECTOR:
                    await updateHyperCatalog(connectionId, conn.catalog, executor);
                    break;
                case TRINO_CONNECTOR:
                    await updateTrinoCatalog(connectionId, conn.details.value, conn.catalog, executor);
                    break;
                case DEMO_CONNECTOR:
                case SERVERLESS_CONNECTOR:
                    throw new Error(
                        `catalog updater does not support connector ${conn.connectorInfo.connectorType} yet`,
                    );
            }
            logger.debug("catalog update succeeded", { "connection": connectionId.toString() }, LOG_CTX);

            // Mark the update successful
            connDispatch(connectionId, {
                type: CATALOG_UPDATE_SUCCEEDED,
                value: [updateId],
            });
        } catch (e: any) {
            if ((e.message === 'AbortError')) {
                logger.error("catalog update was cancelled", { "connection": connectionId.toString() }, LOG_CTX);
                connDispatch(connectionId, {
                    type: CATALOG_UPDATE_CANCELLED,
                    value: [updateId, e],
                });
            } else {
                logger.error("catalog update failed", { "connection": connectionId.toString() }, LOG_CTX);
                console.error(e);
                connDispatch(connectionId, {
                    type: CATALOG_UPDATE_FAILED,
                    value: [updateId, e],
                });
            }
        }
    }, [connMap, sfapi, executor]);

    // Allocate the next query id and start the execution
    const update = React.useCallback<CatalogLoader>((connectionId: number, args: CatalogLoaderArgs): [number, Promise<void>] => {
        const updateId = NEXT_CATALOG_UPDATE_ID++;
        const execution = updateImpl(connectionId, args, updateId);
        return [updateId, execution];
    }, [updateImpl]);

    // Maintain a queue
    const [queueState, setQueueState] = React.useState<CatalogLoaderQueue>(() => ({ queue: new Set() }));
    const enqueue = React.useCallback<CatalogLoaderQueueFn>((cid: number) => {
        setQueueState(s => ({ queue: s.queue.add(cid) }));
    }, []);

    // Subscribe the queue
    const updatesInProgress = React.useRef<Set<number> | null>(null);
    React.useEffect(() => {
        const inProgress = updatesInProgress.current ?? new Set();

        // Helper to perform the catalog update
        const doUpdate = async (cid: number) => {
            inProgress.add(cid);
            try {
                logger.info("starting catalog update", { "connection": cid.toString() }, LOG_CTX);
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
        for (const cid of queueState.queue) {
            // Already updating?
            if (inProgress.has(cid)) {
                continue;
            }
            logger.debug("received catalog update request", { "connection": cid.toString() }, LOG_CTX);

            // Find the connection
            const connState = connReg.connectionMap.get(cid);
            if (!connState) {
                logger.warn("failed to resolve connection", { "connection": cid.toString() }, LOG_CTX);
                continue;
            }

            // Has a current catalog update running?
            // Then we skip auto-updates
            if (connState.catalogUpdatesRunning.size > 0) {
                logger.info("skipping redundant catalog update", { "connection": cid.toString() }, LOG_CTX);
                continue;
            }

            // Was there a recent update?
            if (connState.catalogUpdatesFinished.length > 0) {
                const recent = connState.catalogUpdatesFinished[connState.catalogUpdatesFinished.length - 1];
                const now = new Date();
                const elapsed = (recent.finishedAt?.getTime() ?? now.getTime()) - now.getTime();
                if (elapsed < CATALOG_REFRESH_AFTER) {
                    // XXX Add option to force the update
                    logger.info("skipping catalog update", { "elapsed": elapsed.toString(), "threshold": CATALOG_REFRESH_AFTER.toString() }, LOG_CTX)
                    continue;
                }
            }

            // Perform the catalog update
            doUpdate(cid);
            // Remember that we processed the connection id
            processed.push(cid);
        }

        // No processed?
        if (processed.length == 0) {
            return;
        }

        // Remove all processed ids from the queue
        setQueueState(s => {
            // Remove
            for (const cid of processed) {
                s.queue.delete(cid)
            }
            return { ...s, queue: s.queue };
        });
    }, [queueState]);

    return (
        <LOADER_QUEUE_FN_CTX.Provider value={enqueue}>
            <LOADER_CTX.Provider value={update}>
                {props.children}
            </LOADER_CTX.Provider>
        </LOADER_QUEUE_FN_CTX.Provider>
    );
}
