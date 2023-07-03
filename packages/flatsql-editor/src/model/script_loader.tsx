import React from 'react';

import { ScriptMetadata } from './script_metadata';

type ScriptLoader = (script: ScriptMetadata) => Promise<string | null>;

interface ScriptLoadingState {
    script: ScriptMetadata;
    inflight: Promise<string>;
    content: string | null;
    error: Error | null;
}

interface State {
    scripts: Map<string, ScriptLoadingState>;
}
interface Props {
    children: React.ReactElement;
}

const resolverCtx = React.createContext<ScriptLoader | null>(null);

export const ScriptLoaderProvider: React.FC<Props> = (props: Props) => {
    const state = React.useRef<State>({
        scripts: new Map<string, ScriptLoadingState>(),
    });
    const resolver = React.useCallback<ScriptLoader>(async (script: ScriptMetadata) => {
        // Requested before?
        const previous = state.current.scripts.get(script.scriptId);
        if (previous) {
            // Has content?
            if (previous.content) {
                return previous.content;
            }
            // Has error?
            if (previous.error) {
                throw previous.error;
            }
            // Otherwise await the promise
            return await previous.inflight;
        }
        const loadingState: ScriptLoadingState = {
            script,
            inflight: Promise.reject('unsupported script type'),
            content: null,
            error: null,
        };
        // Otherwise load the url
        if (script.httpURL) {
            loadingState.inflight = (async () => {
                try {
                    const response = await fetch(script.httpURL!);
                    const content = await response.text();
                    return content;
                } catch (e) {
                    loadingState.error = e as Error;
                    throw e;
                }
            })();
        }
        return await loadingState.inflight;
    }, []);
    return <resolverCtx.Provider value={resolver}>{props.children}</resolverCtx.Provider>;
};

export const useScriptLoader = (): ScriptLoader => React.useContext(resolverCtx)!;
