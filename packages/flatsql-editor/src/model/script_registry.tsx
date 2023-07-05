import React from 'react';
import Immutable from 'immutable';

import * as utils from '../utils';
import { Action, Dispatch } from './action';
import { ScriptMetadata, ScriptType, ScriptOriginType, createScriptMetadata } from './script_metadata';
import { exampleScripts } from './example_scripts';

export interface ScriptRegistry {
    scripts: Immutable.Map<string, ScriptMetadata>;
}

export const CREATE_BLANK_SCRIPT = Symbol('CREATE_BLANK');
export const SAVE_SCRIPT = Symbol('SAVE_SCRIPT');

export type ScriptRegistryAction =
    | Action<typeof SAVE_SCRIPT, ScriptMetadata>
    | Action<typeof CREATE_BLANK_SCRIPT, undefined>;

export const generateLocalFileName = (state: ScriptRegistry): string => {
    let name: string;
    do {
        name = `${utils.generateRandomHexString(8)}.sql`;
    } while (state.scripts.has(name));
    return name;
};

export const generateBlankScript = (state: ScriptRegistry): ScriptMetadata =>
    createScriptMetadata({
        name: generateLocalFileName(state),
        scriptType: ScriptType.UNKNOWN,
        originType: ScriptOriginType.LOCAL,
        httpURL: null,
        githubAccount: null,
        githubGistName: null,
        schemaId: null,
    });

export const forkLocal = (state: ScriptRegistry, script: ScriptMetadata): ScriptMetadata =>
    createScriptMetadata({
        ...script,
        name: generateLocalFileName(state),
        originType: ScriptOriginType.LOCAL,
    });

export const reduceScriptRegistry = (ctx: ScriptRegistry, action: ScriptRegistryAction): ScriptRegistry => {
    switch (action.type) {
        case CREATE_BLANK_SCRIPT: {
            const script = generateBlankScript(ctx);
            return { ...ctx, scripts: ctx.scripts.set(script.scriptId, script) };
        }
        case SAVE_SCRIPT: {
            return { ...ctx, scripts: ctx.scripts.set(action.value.scriptId, action.value) };
        }
    }
};

const initialScriptRegistry: ScriptRegistry = {
    scripts: Immutable.Map<string, ScriptMetadata>(exampleScripts.map(s => [s.scriptId, s])),
};
const scriptRegistryCtx = React.createContext<ScriptRegistry>(initialScriptRegistry);
const scriptRegistryDispatchCtx = React.createContext<Dispatch<ScriptRegistryAction>>(() => {});

type Props = {
    children: React.ReactElement;
};

export const ScriptRegistryProvider: React.FC<Props> = (props: Props) => {
    const [s, d] = React.useReducer(reduceScriptRegistry, initialScriptRegistry);
    return (
        <scriptRegistryCtx.Provider value={s}>
            <scriptRegistryDispatchCtx.Provider value={d}>{props.children}</scriptRegistryDispatchCtx.Provider>
        </scriptRegistryCtx.Provider>
    );
};

export const useScriptRegistry = (): ScriptRegistry => React.useContext(scriptRegistryCtx);
export const useScriptRegistryDispatch = (): Dispatch<ScriptRegistryAction> =>
    React.useContext(scriptRegistryDispatchCtx);
