import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScriptEditor, type ScriptEditorDependencies } from './script_editor.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const state = { codeMirrorProps: null as any };
const dependencies = {
    createCodeMirrorExtensions: () => [],
    CodeMirror: React.forwardRef((props: any, _ref) => {
        state.codeMirrorProps = props;
        return <div data-testid="codemirror" />;
    }),
    useSessionScripts: () => [{
        scripts: {
            7: {
                scriptKey: 7,
                scriptSession: { getText: () => 'SELECT\n    1;' },
                connection: { catalog: {} },
            },
        },
    }, vi.fn()],
    useAppConfig: () => ({ settings: {} }),
    useLogger: () => ({ debug: vi.fn() }),
} as unknown as ScriptEditorDependencies;

describe('ScriptEditor', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        state.codeMirrorProps = null;
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    it('seeds CodeMirror with the loaded script before its first layout', () => {
        act(() => root.render(<ScriptEditor sessionId="session" scriptKey={7} autoHeight dependencies={dependencies} />));

        expect(state.codeMirrorProps.initialDoc).toBe('SELECT\n    1;');
        expect(state.codeMirrorProps.style).toEqual({ height: 'auto' });
    });
});
