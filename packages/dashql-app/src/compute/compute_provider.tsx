import * as React from 'react';

import { ComputeWorkerBindings } from "./compute_worker_bindings.js";
import { useLogger } from '../platform/logger_provider.js';

const WASM_URL = new URL('@ankoh/dashql-compute/dashql_compute_bg.wasm', import.meta.url);
const WORKER_CTX = React.createContext<ComputeWorkerBindings | null>(null);

interface Props {
    children?: React.ReactElement;
}

export const DashQLComputeProvider: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const worker = React.useMemo<ComputeWorkerBindings>(() => {
        // Create the web worker
        const worker = new Worker(new URL('./compute_worker_init.js', import.meta.url));
        // Create the worker bindings
        const bindings = new ComputeWorkerBindings(logger, worker);
        // Instantiate the worker
        bindings.instantiate(WASM_URL.toString());
        return bindings;
    }, []);
    return (
        <WORKER_CTX.Provider value={worker}>
            {props.children}
        </WORKER_CTX.Provider>
    );
};

export const useDashQLComputeWorker = () => React.useContext(WORKER_CTX)!;
