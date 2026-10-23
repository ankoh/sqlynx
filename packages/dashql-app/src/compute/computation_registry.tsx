import * as React from 'react';
import { ComputationAction, ComputationState, createComputationState, reduceComputationState } from "./computation_state.js";
import { Dispatch } from '../utils/variant.js';
import { useStore, useStoreState } from '../utils/store.js';
import { useLogger } from '../platform/logger/logger_provider.js';
import { DataFrameRegistry } from './data_frame.js';

// The state changes with every computation task step while dispatch and the data frame registry are stable.
// Keep them in separate contexts so that consumers that only dispatch don't re-render on every step.
const COMPUTATION_STATE_CTX = React.createContext<ComputationState | null>(null);
const COMPUTATION_DISPATCH_CTX = React.createContext<Dispatch<ComputationAction> | null>(null);
const DATA_FRAME_REGISTRY_CTX = React.createContext<DataFrameRegistry | null>(null);

export const useComputationRegistry = (): [ComputationState, Dispatch<ComputationAction>, DataFrameRegistry] => [
    React.useContext(COMPUTATION_STATE_CTX)!,
    React.useContext(COMPUTATION_DISPATCH_CTX)!,
    React.useContext(DATA_FRAME_REGISTRY_CTX)!,
];
export const useComputationDispatch = () => React.useContext(COMPUTATION_DISPATCH_CTX)!;
export const useDataFrameRegistry = () => React.useContext(DATA_FRAME_REGISTRY_CTX)!;

interface ComputationRegistryProps {
    children: React.ReactElement[] | React.ReactElement;
}

export function ComputationRegistry(props: ComputationRegistryProps) {
    const logger = useLogger();
    const dataFrameMemory = React.useMemo(() => new DataFrameRegistry(logger), []);
    // Reducing acquires and releases data frames, the store runs every action once
    const store = useStore<ComputationState>(createComputationState);
    const state = useStoreState(store);
    const dispatch = React.useCallback((action: ComputationAction) => {
        store.update(state => reduceComputationState(state, action, dataFrameMemory));
    }, [store, dataFrameMemory]);
    return (
        <DATA_FRAME_REGISTRY_CTX.Provider value={dataFrameMemory}>
            <COMPUTATION_DISPATCH_CTX.Provider value={dispatch}>
                <COMPUTATION_STATE_CTX.Provider value={state}>
                    {props.children}
                </COMPUTATION_STATE_CTX.Provider>
            </COMPUTATION_DISPATCH_CTX.Provider>
        </DATA_FRAME_REGISTRY_CTX.Provider>
    );
}
