import React from 'react';
import Immutable from 'immutable';

import { SQLynxCatalog } from '@ankoh/sqlynx';
import {
    UPDATE_SALESFORCE_DATA_CLOUD_METADATA,
    UpdateDataCloudMetadataTask,
    updateDataCloudMetadata,
} from './salesforce_catalog_loader';
import { Action, Dispatch } from '../utils';

export type CatalogLoadTaskVariant = Action<typeof UPDATE_SALESFORCE_DATA_CLOUD_METADATA, UpdateDataCloudMetadataTask>;

export enum CatalogLoadTaskStatus {
    STARTED = 0,
    SUCCEEDED = 2,
    FAILED = 3,
    CANCELLED = 4,
}

export interface CatalogLoadTaskState {
    /// The task key
    taskId: number;
    /// The task
    task: CatalogLoadTaskVariant;
    /// The status
    status: CatalogLoadTaskStatus;
    /// The cancellation signal
    cancellation: AbortController;
    /// The loading error (if any)
    error: Error | null;
    /// The time at which the loading started (if any)
    startedAt: Date | null;
    /// The time at which the loading finishe (if any)
    finishedAt: Date | null;
}

export interface CatalogLoaderState {
    /// The tasks
    tasks: Immutable.Map<number, CatalogLoadTaskState>;
}

const TASK_REJECTED_CATALOG_MISSING = Symbol('TASK_FAILED_CATALOG_MISSING');
const TASK_FAILED = Symbol('TASK_FAILED');
const TASK_STARTED = Symbol('TASK_STARTED');
const TASK_SUCCEEDED = Symbol('TASK_SUCCEEDED');
const TASK_CANCELLED = Symbol('TASK_CANCELLED');

type CatalogStateActionVarient =
    | Action<typeof TASK_REJECTED_CATALOG_MISSING, [number, CatalogLoadTaskVariant]>
    | Action<typeof TASK_STARTED, [number, CatalogLoadTaskVariant, AbortController]>
    | Action<typeof TASK_SUCCEEDED, number>
    | Action<typeof TASK_CANCELLED, number>
    | Action<typeof TASK_FAILED, [number, any]>;

function reduceCatalogLoaderState(state: CatalogLoaderState, action: CatalogStateActionVarient): CatalogLoaderState {
    switch (action.type) {
        case TASK_REJECTED_CATALOG_MISSING: {
            const [taskId, task] = action.value;
            const error = new Error('catalog is not set');
            const now = new Date();
            return {
                tasks: state.tasks.set(taskId, {
                    taskId,
                    task,
                    status: CatalogLoadTaskStatus.FAILED,
                    cancellation: new AbortController(),
                    error: error,
                    startedAt: now,
                    finishedAt: now,
                }),
            };
        }
        case TASK_STARTED: {
            const [taskId, task, cancellation] = action.value;
            return {
                tasks: state.tasks.set(taskId, {
                    taskId,
                    task,
                    status: CatalogLoadTaskStatus.STARTED,
                    cancellation: cancellation,
                    error: null,
                    startedAt: new Date(),
                    finishedAt: null,
                }),
            };
        }
        case TASK_FAILED: {
            const [taskId, error] = action.value;
            const task = state.tasks.get(taskId)!;
            return {
                tasks: state.tasks.set(taskId, {
                    ...task,
                    status: CatalogLoadTaskStatus.FAILED,
                    error,
                    finishedAt: new Date(),
                }),
            };
        }
        case TASK_CANCELLED: {
            const taskId = action.value;
            const task = state.tasks.get(taskId)!;
            return {
                tasks: state.tasks.set(taskId, {
                    ...task,
                    status: CatalogLoadTaskStatus.FAILED,
                    finishedAt: new Date(),
                }),
            };
        }
        case TASK_SUCCEEDED: {
            const taskId = action.value;
            const task = state.tasks.get(taskId)!;
            return {
                tasks: state.tasks.set(taskId, {
                    ...task,
                    status: CatalogLoadTaskStatus.SUCCEEDED,
                    finishedAt: new Date(),
                }),
            };
        }
    }
}

const UPDATER_STATE_CTX = React.createContext<CatalogLoaderState | null>(null);
const UPDATER_DISPATCH_CTX = React.createContext<Dispatch<CatalogLoadTaskVariant> | null>(null);

interface Props {
    catalog: SQLynxCatalog | null;
    catalogWasUpdated: () => void;
    children: React.ReactElement;
}

export const CatalogLoader: React.FC<Props> = (props: Props) => {
    const nextTaskKey = React.useRef<number>(1);
    const [state, modifyState] = React.useReducer<typeof reduceCatalogLoaderState, undefined>(
        reduceCatalogLoaderState,
        undefined,
        () => ({
            catalog: null,
            tasks: Immutable.Map(),
        }),
    );
    const dispatchTask = React.useCallback(
        (task: CatalogLoadTaskVariant) => {
            const taskId = nextTaskKey.current++;
            if (!props.catalog) {
                modifyState({
                    type: TASK_REJECTED_CATALOG_MISSING,
                    value: [taskId, task],
                });
                return;
            }
            switch (task.type) {
                case UPDATE_SALESFORCE_DATA_CLOUD_METADATA: {
                    const cancellation = new AbortController();
                    const catalog = props.catalog;
                    modifyState({
                        type: TASK_STARTED,
                        value: [taskId, task, cancellation],
                    });
                    const run = async () => {
                        try {
                            await updateDataCloudMetadata(catalog, task.value, cancellation);
                            modifyState({
                                type: TASK_SUCCEEDED,
                                value: taskId,
                            });
                        } catch (e: any) {
                            if ((e.message = 'AbortError')) {
                                modifyState({
                                    type: TASK_CANCELLED,
                                    value: taskId,
                                });
                            } else {
                                modifyState({
                                    type: TASK_FAILED,
                                    value: [taskId, e],
                                });
                            }
                        }
                        props.catalogWasUpdated();
                    };
                    run();
                    break;
                }
            }
        },
        [modifyState, props.catalog],
    );
    return (
        <UPDATER_STATE_CTX.Provider value={state}>
            <UPDATER_DISPATCH_CTX.Provider value={dispatchTask}>{props.children}</UPDATER_DISPATCH_CTX.Provider>
        </UPDATER_STATE_CTX.Provider>
    );
};

export const useCatalogLoader = (): Dispatch<CatalogLoadTaskVariant> => React.useContext(UPDATER_DISPATCH_CTX)!;
