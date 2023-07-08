import * as flatsql from '@ankoh/flatsql';
import React from 'react';
import { RESULT_ERROR, RESULT_OK, Result } from './utils/result';

import wasm from '@ankoh/flatsql/dist/flatsql.wasm';

interface Props {
    children: JSX.Element;
}

const MODULE_CONTEXT = React.createContext<Result<flatsql.FlatSQL> | null>(null);
export const useFlatSQL = (): Result<flatsql.FlatSQL> => React.useContext(MODULE_CONTEXT)!;

export const FlatSQLLoader: React.FC<Props> = (props: Props) => {
    const [backend, setBackend] = React.useState<Result<flatsql.FlatSQL> | null>(null);
    React.useEffect(() => {
        (async () => {
            try {
                const instance = await flatsql.FlatSQL.create(async (imports: WebAssembly.Imports) => {
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
