import * as flatsql from '@ankoh/flatsql';
import React from 'react';
import { Resolvable, ResolvableStatus, Resolver } from './utils/resolvable';

import wasm from '@ankoh/flatsql/dist/flatsql.wasm';

interface Backend {
    instance: Resolvable<flatsql.FlatSQL | null>;
}

interface Props {
    children: JSX.Element;
}

const BACKEND_RESOLVER_CONTEXT = React.createContext<Resolver<Backend | null> | null>(null);
const BACKEND_CONTEXT = React.createContext<Resolvable<Backend> | null>(null);
export const useBackend = (): Resolvable<Backend> => React.useContext(BACKEND_CONTEXT)!;
export const useBackendResolver = (): Resolver<Backend | null> => React.useContext(BACKEND_RESOLVER_CONTEXT)!;

export const BackendProvider: React.FC<Props> = (props: Props) => {
    const inFlight = React.useRef<Promise<Backend> | null>(null);
    const [backend, setBackend] = React.useState<Resolvable<Backend>>(
        new Resolvable<Backend>(ResolvableStatus.NONE, {
            instance: new Resolvable<flatsql.FlatSQL | null>(ResolvableStatus.NONE, null),
        }),
    );
    const resolver = React.useCallback(async () => {
        if (inFlight.current) return await inFlight.current;
        inFlight.current = (async () => {
            // Initialize the parser
            let b = backend;
            const [parser, parserError] = await initParser();
            if (parserError != null) {
                b = b.failWith(parserError);
                setBackend(b);
                return b.value;
            }

            // All done, complete backend
            b = b.completeWith({
                instance: b.value.instance.completeWith(parser),
            });
            setBackend(b);
            return b.value;
        })();
        return await inFlight.current;
    }, []);
    return (
        <BACKEND_RESOLVER_CONTEXT.Provider value={resolver}>
            <BACKEND_CONTEXT.Provider value={backend}>{props.children}</BACKEND_CONTEXT.Provider>
        </BACKEND_RESOLVER_CONTEXT.Provider>
    );
};

async function initParser(): Promise<[flatsql.FlatSQL | null, Error | null]> {
    try {
        const instance = await flatsql.FlatSQL.instantiateStreaming(fetch(wasm));
        return [instance, null];
    } catch (e: any) {
        console.error(e);
        return [null, e];
    }
}
