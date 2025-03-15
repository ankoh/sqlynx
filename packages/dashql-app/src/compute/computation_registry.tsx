import * as React from 'react';
import { ComputationAction, ComputationState, createComputationState, reduceComputationState } from "./computation_state.js";
import { Dispatch } from '../utils/variant.js';

const COMPUTATION_SCHEDULER_CTX = React.createContext<[ComputationState, Dispatch<ComputationAction>] | null>(null);

export const useComputationRegistry = () => React.useContext(COMPUTATION_SCHEDULER_CTX)!;

interface ComputationRegistryProps {
    children: React.ReactElement[] | React.ReactElement;
}

export function ComputationRegistry(props: ComputationRegistryProps) {
    const [state, dispatch] = React.useReducer(reduceComputationState, null, createComputationState);
    return (
        <COMPUTATION_SCHEDULER_CTX.Provider value={[state, dispatch]}>
            {props.children}
        </COMPUTATION_SCHEDULER_CTX.Provider>
    );
}
