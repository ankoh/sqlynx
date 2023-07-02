import React from 'react';

import { Script } from './script';
import { SET_SCRIPT_CONTENT, useScriptRegistryDispatch } from './script_registry';

type ScriptLoader = (script: Script) => Promise<string | null>;

interface ScriptLoadingPromise {
    script: Script;
    loader: Promise<string | null>;
}

interface ScriptLoaderState {
    scripts: Map<string, ScriptLoadingPromise>;
}

type Props = {
    children: React.ReactElement;
};

const resolverCtx = React.createContext<ScriptLoader | null>(null);

export const ScriptLoaderProvider: React.FC<Props> = (props: Props) => {
    const registryDispatch = useScriptRegistryDispatch();
    const state = React.useRef<ScriptLoaderState>({
        scripts: new Map<string, ScriptLoadingPromise>(),
    });
    const resolver = React.useCallback<ScriptLoader>(
        async (script: Script) => {
            // Already loaded?
            if (script.content != null) return script.content;
            // Load pending?
            const inflight = state.current.scripts.get(script.scriptId);
            if (inflight) {
                return await inflight.loader;
            }
            // Otherwise load the url
            if (script.httpURL) {
                const response = await fetch(script.httpURL);
                const content = await response.text();
                registryDispatch({
                    type: SET_SCRIPT_CONTENT,
                    data: [script.scriptId, content],
                });
                state.current.scripts.delete(script.scriptId);
                return content;
            }
            return null;
        },
        [registryDispatch],
    );
    return <resolverCtx.Provider value={resolver}>{props.children}</resolverCtx.Provider>;
};

export const useScriptLoader = (): ScriptLoader => React.useContext(resolverCtx)!;
