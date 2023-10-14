import * as sqlynx from '@ankoh/sqlynx';
import React from 'react';
import { RESULT_ERROR, RESULT_OK, Result } from './utils/result';

import wasm from '@ankoh/sqlynx/dist/sqlynx.wasm';

interface Props {
    children: JSX.Element;
}

const MODULE_CONTEXT = React.createContext<Result<sqlynx.SQLynx> | null>(null);
export const useSQLynx = (): Result<sqlynx.SQLynx> => React.useContext(MODULE_CONTEXT)!;

export const SQLynxLoader: React.FC<Props> = (props: Props) => {
    const [backend, setBackend] = React.useState<Result<sqlynx.SQLynx> | null>(null);
    React.useEffect(() => {
        (async () => {
            try {
                const instance = await sqlynx.SQLynx.create(async (imports: WebAssembly.Imports) => {
                    return await WebAssembly.instantiateStreaming(fetch(wasm), imports);
                });
                setBackend({
                    type: RESULT_OK,
                    value: instance!,
                });
            } catch (e: any) {
                console.error(e);
                setBackend({
                    type: RESULT_ERROR,
                    error: e!,
                });
            }
        })();
    }, []);
    return <MODULE_CONTEXT.Provider value={backend}>{props.children}</MODULE_CONTEXT.Provider>;
};
