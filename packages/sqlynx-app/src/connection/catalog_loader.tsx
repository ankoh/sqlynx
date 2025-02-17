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

let NEXT_CATALOG_UPDATE_ID = 1;

/// The catalog update args
interface CatalogLoaderArgs { }
/// The catalog updater function
export type CatalogLoader = (connectionId: number, args: CatalogLoaderArgs) => [number, Promise<void>];
/// The React context to resolve the active catalog updater
const LOADER_CTX = React.createContext<CatalogLoader | null>(null);
/// The hook to resolve the catalog updater
export const useCatalogUpdater = () => React.useContext(LOADER_CTX)!;

export function CatalogLoaderProvider(props: { children?: React.ReactElement }) {
    const executor = useQueryExecutor();
    const salesforceApi = useSalesforceAPI();

    // The connection registry changes frequently, the connection map is stable.
    // This executor will depend on the map directly since it can resolve everything ad-hoc.
    const [connReg, connDispatch] = useDynamicConnectionDispatch();
    const connMap = connReg.connectionMap;

    // Execute a query with pre-allocated query id
    const updateImpl = React.useCallback(async (connectionId: number, args: CatalogLoaderArgs, updateId: number): Promise<void> => {
        console.log("UPDATE CATALOG");

        // Check if we know the connection id.
        const conn = connMap.get(connectionId);
        if (!conn) {
            throw new Error(`couldn't find a connection with id ${connectionId}`);
        }

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
                    await updateSalesforceCatalog(conn.details.value, conn.catalog, salesforceApi, abortController);
                    break;
                case HYPER_GRPC_CONNECTOR:
                    await updateHyperCatalog(connectionId, conn.catalog, executor);
                    break;
                case TRINO_CONNECTOR:
                    await updateTrinoCatalog(connectionId, conn.catalog, executor);
                    break;
                case DEMO_CONNECTOR:
                case SERVERLESS_CONNECTOR:
                    throw new Error(
                        `catalog updater does not support connector ${conn.connectorInfo.connectorType} yet`,
                    );
            }
            // Mark the update successful
            connDispatch(connectionId, {
                type: CATALOG_UPDATE_SUCCEEDED,
                value: [updateId],
            });
        } catch (e: any) {
            if ((e.message === 'AbortError')) {
                connDispatch(connectionId, {
                    type: CATALOG_UPDATE_CANCELLED,
                    value: [updateId, e],
                });
            } else {
                console.error(e);
                connDispatch(connectionId, {
                    type: CATALOG_UPDATE_FAILED,
                    value: [updateId, e],
                });
            }
        }
    }, [connMap, salesforceApi]);

    // Allocate the next query id and start the execution
    const update = React.useCallback<CatalogLoader>((connectionId: number, args: CatalogLoaderArgs): [number, Promise<void>] => {
        const updateId = NEXT_CATALOG_UPDATE_ID++;
        const execution = updateImpl(connectionId, args, updateId);
        return [updateId, execution];
    }, [updateImpl]);

    return (
        <LOADER_CTX.Provider value={update}>
            {props.children}
        </LOADER_CTX.Provider>
    );
}
