import React from 'react';

import { Script } from './script';
import { SET_SCRIPT_CONTENT, useScriptRegistryDispatch } from './script_registry';

type ScriptResolver = (script: Script) => Promise<void>;

interface ScriptLoader {
    script: Script;
    loader: Promise<void>;
}

interface ScriptLoaderState {
    scripts: Map<string, ScriptLoader>;
}

type Props = {
    children: React.ReactElement;
};

const resolverCtx = React.createContext<ScriptResolver | null>(null);

export const ScriptLoaderProvider: React.FC<Props> = (props: Props) => {
    const registryDispatch = useScriptRegistryDispatch();
    const state = React.useRef<ScriptLoaderState>({
        scripts: new Map<string, ScriptLoader>(),
    });
    const resolver = React.useCallback<ScriptResolver>(
        async (script: Script) => {
            // Already loaded?
            if (script.content != null) return;
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
            }
        },
        [registryDispatch],
    );
    return <resolverCtx.Provider value={resolver}>{props.children}</resolverCtx.Provider>;
};

export const useScriptResolver = (): ScriptResolver => React.useContext(resolverCtx)!;
