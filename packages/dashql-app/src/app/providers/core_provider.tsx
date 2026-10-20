import * as dashql from '@ankoh/dashql-core';
import * as React from 'react';

import { useLogger } from '../../platform/logger/logger_provider.js';
import { TracedLogger, stringifyError } from '../../platform/logger/logger.js';
import { createTrace } from '../../platform/logger/trace_context.js';
import { decodedContentLength } from '../../utils/content_length.js';
import { disposeCatalogBatchWorker, initializeCatalogBatchWorker } from '../notebook/connections/catalog_batch.js';

// Load the WebAssembly asset through the core package export.
// eslint-disable-next-line import/no-unresolved -- resolved by bundler
import coreWasmUrl from '@ankoh/dashql-core/wasm?url';
const DASHQL_WASM_URL = typeof coreWasmUrl === 'string' ? coreWasmUrl : new URL(coreWasmUrl as string, import.meta.url).href;

export interface InstantiationProgress {
    startedAt: Date;
    updatedAt: Date;
    bytesTotal: bigint;
    bytesLoaded: bigint;
}

const INSTANTIATOR_CONTEXT = React.createContext<((context: string) => Promise<dashql.DashQL>) | null>(null);
const PROGRESS_CONTEXT = React.createContext<InstantiationProgress | null>(null);

export interface DashQLCoreSetupOptions {
    setupBatchWorker: boolean;
}

interface Props {
    children: React.ReactElement;
    initialSetup?: DashQLCoreSetupOptions;
}

export const DashQLCoreProvider: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const instantiation = React.useRef<Promise<dashql.DashQL> | null>(null);
    const initialSetup = React.useRef(props.initialSetup);
    const lifecycle = React.useRef<{ disposed: boolean; core: dashql.DashQL | null }>({ disposed: false, core: null });
    const [progress, setProgress] = React.useState<InstantiationProgress | null>(null);

    const instantiator = React.useCallback(async (context: string): Promise<dashql.DashQL> => {
        const owner = lifecycle.current;
        if (owner.disposed) throw new DOMException('Core provider was disposed', 'AbortError');
        /// Already instantiated?
        if (instantiation.current != null) {
            return await instantiation.current;
        }

        // Create instantiation progress
        const now = new Date();
        const internal: InstantiationProgress = {
            startedAt: now,
            updatedAt: now,
            bytesTotal: BigInt(0),
            bytesLoaded: BigInt(0),
        };

        // Fetch an url with progress tracking (url is string from ?url import or URL)
        const fetchWithProgress = async (url: string | URL, traced: TracedLogger) => {
            traced.info("Fetching core wasm", { "context": context }, "core");

            // Try to determine file size
            const request = new Request(url);
            const response = await fetch(request);
            if (!response.ok) {
                throw new Error(`Failed to fetch core wasm: ${response.status} ${response.statusText}`);
            }
            const contentLength = decodedContentLength(response);

            const now = new Date();
            internal.startedAt = now;
            internal.updatedAt = now;
            internal.bytesTotal = BigInt(contentLength) || BigInt(0);
            internal.bytesLoaded = BigInt(0);

            const tracker = {
                transform(chunk: Uint8Array, ctrl: TransformStreamDefaultController) {
                    const prevUpdate = internal.updatedAt;
                    internal.updatedAt = new Date();
                    internal.bytesLoaded += BigInt(chunk.byteLength);
                    if (internal.updatedAt.getTime() - prevUpdate.getTime() > 20) {
                        setProgress(_ => ({ ...internal }));
                    }
                    ctrl.enqueue(chunk);
                },
            };
            const ts = new TransformStream(tracker);
            return new Response(response.body?.pipeThrough(ts), response);
        };

        const instantiate = async (): Promise<dashql.DashQL> => {
            const traced = logger.withTrace(createTrace());
            const initStart = performance.now();
            try {
                traced.info("Loading core Wasm", { "context": context }, "core");
                const response = await fetchWithProgress(DASHQL_WASM_URL, traced);
                const wasmBinary = new Uint8Array(await response.arrayBuffer());
                const instance = await dashql.DashQL.create({ wasmBinary });
                owner.core = instance;
                if (owner.disposed) {
                    disposeCatalogBatchWorker(instance);
                    throw new DOMException('Core provider was disposed', 'AbortError');
                }
                if (initialSetup.current?.setupBatchWorker) {
                    try {
                        await initializeCatalogBatchWorker(instance);
                    } catch (error) {
                        if (owner.disposed) throw new DOMException('Core provider was disposed', 'AbortError');
                        disposeCatalogBatchWorker(instance);
                        throw error;
                    }
                }
                if (owner.disposed) throw new DOMException('Core provider was disposed', 'AbortError');

                const initEnd = performance.now();
                traced.info("Instantiated core", {
                    "context": context,
                    "duration": Math.floor(initEnd - initStart).toString()
                }, "core");

                setProgress(_ => ({
                    ...internal,
                    updatedAt: new Date(),
                }));

                return instance;
            } catch (e: any) {
                const initEnd = performance.now();
                traced.error("Failed to instantiate core", {
                    "error": stringifyError(e),
                    "duration": Math.floor(initEnd - initStart).toString()
                }, "core");
                throw e;
            }
        };
        // Start the instantiation
        instantiation.current = instantiate();
        // Await the instantiation
        return await instantiation.current;

    }, [logger, setProgress]);

    React.useEffect(() => {
        if (lifecycle.current.disposed) lifecycle.current = { disposed: false, core: null };
        const owner = lifecycle.current;
        return () => {
            owner.disposed = true;
            if (owner.core) disposeCatalogBatchWorker(owner.core);
            instantiation.current = null;
        };
    }, []);

    return (
        <INSTANTIATOR_CONTEXT.Provider value={instantiator}>
            <PROGRESS_CONTEXT.Provider value={progress}>
                {props.children}
            </PROGRESS_CONTEXT.Provider>
        </INSTANTIATOR_CONTEXT.Provider>
    );
};

export const useDashQLCoreSetupProgress = (): InstantiationProgress | null => React.useContext(PROGRESS_CONTEXT);

export type DashQLSetupFn = (context: string) => Promise<dashql.DashQL>;
export function useDashQLCoreSetup(): DashQLSetupFn {
    return React.useContext(INSTANTIATOR_CONTEXT)!;
};
