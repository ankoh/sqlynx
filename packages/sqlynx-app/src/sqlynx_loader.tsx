import * as sqlynx from '@ankoh/sqlynx-core';
import * as React from 'react';

import { RESULT_ERROR, RESULT_OK, Result } from './utils/result.js';
import { useLogger } from './platform/logger_provider.js';

const SQLYNX_MODULE_URL = new URL('@ankoh/sqlynx-core/dist/sqlynx.wasm', import.meta.url);

export interface InstantiationProgress {
    startedAt: Date;
    updatedAt: Date;
    bytesTotal: bigint;
    bytesLoaded: bigint;
}

const INSTANTIATOR_CONTEXT = React.createContext<((context: string) => void) | null>(null);
const MODULE_CONTEXT = React.createContext<Result<sqlynx.SQLynx> | null>(null);
const PROGRESS_CONTEXT = React.createContext<InstantiationProgress | null>(null);

interface Props {
    children: JSX.Element;
}

export const SQLynxLoader: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const instantiation = React.useRef<boolean>(false);
    const [mod, setModule] = React.useState<Result<sqlynx.SQLynx> | null>(null);
    const [progress, setProgress] = React.useState<InstantiationProgress | null>(null);

    const instantiator = React.useCallback((context: string) => {
        /// Already instantiated?
        if (instantiation.current) {
            return;
        }
        instantiation.current = true;

        // Create instantiation progress
        const now = new Date();
        const internal: InstantiationProgress = {
            startedAt: now,
            updatedAt: now,
            bytesTotal: BigInt(0),
            bytesLoaded: BigInt(0),
        };
        // Fetch an url with progress tracking
        const fetchWithProgress = async (url: URL) => {
            logger.info(`instantiating core for ${context}`, "sqlynx_loader");

            // Try to determine file size
            const request = new Request(url);
            const response = await fetch(request);
            const contentLengthHdr = response.headers.get('content-length');
            const contentLength = contentLengthHdr ? parseInt(contentLengthHdr, 10) || 0 : 0;

            const now = new Date();
            internal.startedAt = now;
            internal.updatedAt = now;
            internal.bytesTotal = BigInt(contentLength) || BigInt(0);
            internal.bytesLoaded = BigInt(0);
            const tracker = {
                transform(chunk: Uint8Array, ctrl: TransformStreamDefaultController) {
                    const prevUpdate = internal.updatedAt;
                    internal.updatedAt = now;
                    internal.bytesLoaded += BigInt(chunk.byteLength);
                    if (now.getTime() - prevUpdate.getTime() > 20) {
                        setProgress(_ => ({ ...internal }));
                    }
                    ctrl.enqueue(chunk);
                },
            };
            const ts = new TransformStream(tracker);
            return new Response(response.body?.pipeThrough(ts), response);
        };
        const instantiate = async () => {
            try {
                var initStart = performance.now();
                const instance = await sqlynx.SQLynx.create(async (imports: WebAssembly.Imports) => {
                    return await WebAssembly.instantiateStreaming(fetchWithProgress(SQLYNX_MODULE_URL), imports);
                });
                var initEnd = performance.now();
                logger.info(`instantiated core in ${Math.floor(initEnd - initStart)} ms`, "sqlynx_loader");
                setProgress(_ => ({
                    ...internal,
                    updatedAt: new Date(),
                }));
                setModule({
                    type: RESULT_OK,
                    value: instance!,
                });
            } catch (e: any) {
                console.error(e);
                setModule({
                    type: RESULT_ERROR,
                    error: e!,
                });
            }
        };
        instantiate();
    }, [logger, setModule, setProgress]);

    return (
        <INSTANTIATOR_CONTEXT.Provider value={instantiator}>
            <MODULE_CONTEXT.Provider value={mod}>
                <PROGRESS_CONTEXT.Provider value={progress}>
                    {props.children}
                </PROGRESS_CONTEXT.Provider>
            </MODULE_CONTEXT.Provider>
        </INSTANTIATOR_CONTEXT.Provider>
    );
};

export const useSQLynxSetupProgress = (): InstantiationProgress | null => React.useContext(PROGRESS_CONTEXT);
export const useSQLynxSetup = (): ((context: string) => Result<sqlynx.SQLynx> | null) => {
    // Resolve function to instantiate the module
    const instantiate = React.useContext(INSTANTIATOR_CONTEXT)!;
    // Get the module
    const mod = React.useContext(MODULE_CONTEXT);
    // Create a getter to instantiate on access
    return (context: string) => {
        instantiate(context);
        return mod;
    };
};
