import * as React from 'react';
import { ComputationState, createComputationState, reduceComputationState } from "./computation_state.js";

const CTX = React.createContext<ComputationState | null>(null);

interface ComputationSchedulerProps {
}

function useComputationScheduler() {

}

function ComputationScheduler(props: ComputationSchedulerProps) {
    const [state, dispatch] = React.useReducer(reduceComputationState, null, createComputationState);



    return (
    );
}
