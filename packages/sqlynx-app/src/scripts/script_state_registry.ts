import * as React from 'react';

import { ScriptState } from './script_state';
import { Dispatch } from '../utils/variant';
import { ScriptStateAction, reduceScriptState } from './script_state_reducer';

/// ATTENTION
///
/// React reducers do not play nice together with the "impure" side-effects through state held in Wasm.
/// When running react in strict mode, React will call our reducers multiple times with the same state.
/// Moving all interactions and memory management OUT of the reducer is far too painful and nothing we want to do.
///
/// We therefore bypass the "pureness" rules for the top-level state and use a single global state instead.

let GLOBAL_SCRIPTS: Map<number, ScriptState> = new Map();
let NEXT_REGISTRY_ENTRY_ID = 1;

export function useScriptState(id: number | null): [ScriptState | null, Dispatch<ScriptStateAction>] {
    const [state, setState] = React.useState<ScriptState | null>(null);
    React.useEffect(() => {
        setState(id == null ? null : GLOBAL_SCRIPTS.get(id) ?? null);
    }, [id]);
    const reducer = React.useCallback(
        (action: ScriptStateAction) => {
            if (id == null) {
                return;
            }
            const prev = GLOBAL_SCRIPTS.get(id)!;
            const next = reduceScriptState(prev, action);
            GLOBAL_SCRIPTS.set(id, next);
            setState(next);
        },
        [id, setState],
    );
    return [state, reducer];
}

export function registerScript(scriptState: Omit<ScriptState, 'registryEntryId'>): number {
    const entryId = NEXT_REGISTRY_ENTRY_ID++;
    GLOBAL_SCRIPTS.set(entryId, {
        ...scriptState,
        registryEntryId: entryId,
    });
    return entryId;
}

export function getRegisteredScriptCount(): number {
    return GLOBAL_SCRIPTS.size;
}

export function getNextRegisteredScript(id: number | null): number | null {
    const keys = [...GLOBAL_SCRIPTS.keys()];
    keys.sort();
    if (keys.length == 0) {
        return id;
    } else {
        return keys[(keys.findIndex(v => v == id) + 1) % keys.length];
    }
}
