import * as React from 'react';

import { ComputeWorkerBindings } from "./compute_worker_bindings.js";

const WORKER_URL = new URL('./compute_worker.js', import.meta.url);
const WASM_URL = new URL('@ankoh/sqlynx-compute/sqlynx_compute_bg.wasm', import.meta.url);

const WORKER_CTX = React.createContext<ComputeWorkerBindings | null>(null);

interface Props {
    children?: React.ReactElement;
}

export const SQLynxComputeProvider: React.FC<Props> = (props: Props) => {
    return (
        <WORKER_CTX.Provider value={null}>
            {props.children}
        </WORKER_CTX.Provider>
    );
};

export const useSQLynxComputeWorker = () => React.useContext(WORKER_CTX)!;
