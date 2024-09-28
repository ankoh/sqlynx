import * as React from 'react';

import { useDynamicConnectionDispatch } from './connection_registry.js';
import { CatalogTaskVariant, CatalogUpdateTaskState, CatalogUpdateTaskStatus } from './catalog_update_state.js';
import { useSalesforceAPI } from './salesforce/salesforce_connector.js';
import { DEMO_CONNECTOR, HYPER_GRPC_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR, SERVERLESS_CONNECTOR } from './connector_info.js';
import {
    CATALOG_UPDATE_CANCELLED,
    CATALOG_UPDATE_FAILED,
    CATALOG_UPDATE_SUCCEEDED,
    UPDATE_CATALOG,
} from './connection_state.js';
import { updateDataCloudCatalog } from './salesforce/salesforce_catalog_update.js';

let NEXT_CATALOG_UPDATE_ID = 1;

/// The catalog update args
interface CatalogUpdateArgs {
}
/// The catalog updater function
export type CatalogUpdater = (connectionId: number, args: CatalogUpdateArgs) => [number, Promise<void>];
/// The React context to resolve the active catalog updater
const UPDATER_CTX = React.createContext<CatalogUpdater | null>(null);
/// The hook to resolve the catalog updater
export const useCatalogUpdater = () => React.useContext(UPDATER_CTX)!;

export function CatalogUpdaterProvider(props: { children?: React.ReactElement }) {
    const sfApi = useSalesforceAPI();

    // The connection registry changes frequently, the connection map is stable.
    // This executor will depend on the map directly since it can resolve everything ad-hoc.
    const [connReg, connDispatch] = useDynamicConnectionDispatch();
    const connMap = connReg.connectionMap;

    // Execute a query with pre-allocated query id
    const updateWithId = React.useCallback(async (connectionId: number, args: CatalogUpdateArgs, updateId: number): Promise<void> => {
        // Check if we know the connection id.
        const conn = connMap.get(connectionId);
        if (!conn) {
            throw new Error(`couldn't find a connection with id ${connectionId}`);
        }

        // Build the query task
        let task: CatalogTaskVariant;
        switch (conn.details.type) {
            case SALESFORCE_DATA_CLOUD_CONNECTOR: {
                const c = conn.details.value;
                task = {
                    type: SALESFORCE_DATA_CLOUD_CONNECTOR,
                    value: {
                        api: sfApi,
                        accessToken: c.dataCloudAccessToken!,
                        catalog: conn.catalog,
                    },
                };
                break;
            }
            case HYPER_GRPC_CONNECTOR: {
                const c = conn.details.value;
                const channel = c.channel;
                if (!channel) {
                    throw new Error(`hyper channel is not set up`);
                }
                task = {
                    type: HYPER_GRPC_CONNECTOR,
                    value: {
                        catalog: conn.catalog,
                        hyperChannel: channel,
                    }
                }
                break;
            }
            case DEMO_CONNECTOR:
            // XXX
            case SERVERLESS_CONNECTOR:
                throw new Error(
                    `catalog updater does not support connector ${conn.connectionInfo.connectorType} yet`,
                );
        }

        // Accept the query and clear the request
        const abortController = new AbortController();
        const initialState: CatalogUpdateTaskState = {
            taskId: updateId,
            task: task,
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
            switch (task.type) {
                case SALESFORCE_DATA_CLOUD_CONNECTOR: {
                    const metadata = await task.value.api.getDataCloudMetadata(
                        task.value.accessToken,
                        abortController.signal,
                    );
                    updateDataCloudCatalog(task.value.catalog, metadata);
                    break;
                }
                case HYPER_GRPC_CONNECTOR: {
                    // XXX
                    // read pg_class
                    break;
                }
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
    }, [connMap, sfApi]);

    // Allocate the next query id and start the execution
    const execute = React.useCallback<CatalogUpdater>((connectionId: number, args: CatalogUpdateArgs): [number, Promise<void>] => {
        const updateId = NEXT_CATALOG_UPDATE_ID++;
        const execution = updateWithId(connectionId, args, updateId);
        return [updateId, execution];
    }, [updateWithId]);

    return (
        <UPDATER_CTX.Provider value={execute}>
            {props.children}
        </UPDATER_CTX.Provider>
    );
}
