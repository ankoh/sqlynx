import * as flatsql from '@ankoh/flatsql';
import React from 'react';
import { RESULT_ERROR, RESULT_OK, Result } from './utils/result';

import wasm from '@ankoh/flatsql/dist/flatsql.wasm';

interface Props {
    children: JSX.Element;
}

const BACKEND_CONTEXT = React.createContext<Result<flatsql.FlatSQL> | null>(null);
export const useBackend = (): Result<flatsql.FlatSQL> => React.useContext(BACKEND_CONTEXT)!;

export const BackendProvider: React.FC<Props> = (props: Props) => {
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
    return <BACKEND_CONTEXT.Provider value={backend}>{props.children}</BACKEND_CONTEXT.Provider>;
};
