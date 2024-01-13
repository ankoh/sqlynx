import * as sqlynx from '@ankoh/sqlynx';
import React from 'react';
import { RESULT_ERROR, RESULT_OK, Result } from './utils/result';

import wasm from '@ankoh/sqlynx/dist/sqlynx.wasm';

export interface InstantiationProgress {
    startedAt: Date;
    updatedAt: Date;
    bytesTotal: bigint;
    bytesLoaded: bigint;
}

interface Props {
    children: JSX.Element;
}

const PROGRESS_CONTEXT = React.createContext<InstantiationProgress | null>(null);
const MODULE_CONTEXT = React.createContext<Result<sqlynx.SQLynx> | null>(null);

export const SQLynxLoader: React.FC<Props> = (props: Props) => {
    const [module, setModule] = React.useState<Result<sqlynx.SQLynx> | null>(null);
    const [progress, setProgress] = React.useState<InstantiationProgress | null>(null);

    React.useEffect(() => {
        const now = new Date();
        const internal: InstantiationProgress = {
            startedAt: now,
            updatedAt: now,
            bytesTotal: BigInt(0),
            bytesLoaded: BigInt(0),
        };
        // Fetch an url with progress tracking
        const fetchWithProgress = async (url: URL) => {
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
                const instance = await sqlynx.SQLynx.create(async (imports: WebAssembly.Imports) => {
                    return await WebAssembly.instantiateStreaming(fetchWithProgress(wasm), imports);
                });
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
    }, []);
    return (
        <PROGRESS_CONTEXT.Provider value={progress}>
            <MODULE_CONTEXT.Provider value={module}>{props.children}</MODULE_CONTEXT.Provider>
        </PROGRESS_CONTEXT.Provider>
    );
};

export const useSQLynxLoadingProgress = (): InstantiationProgress | null => React.useContext(PROGRESS_CONTEXT);
export const useSQLynx = (): Result<sqlynx.SQLynx> | null => React.useContext(MODULE_CONTEXT);
