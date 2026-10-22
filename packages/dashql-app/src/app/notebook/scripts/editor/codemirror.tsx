import * as React from 'react';
import * as themes from './themes/index.js';

import { EditorState, Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { search, searchKeymap } from '@codemirror/search';
import { EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view';
import { DashQLExtensions, DashQLReadonlyExtensions } from './dashql_extension.js';

import { useLogger } from '../../../../platform/logger/logger_provider.js';

import './codemirror.css';

export interface CodeMirrorProps {
    /// Root of the DOM where the editor is mounted
    root?: ShadowRoot | Document;
    /// Override styles for the container div (e.g. height: 'auto' for auto-expand)
    style?: React.CSSProperties;
    /// Additional extensions appended after the default set
    extraExtensions?: Extension[];
    /// Full editor-specific extension set to use instead of defaults. Shared search is still appended.
    extensions?: Extension[];
    /// Document used when constructing the EditorState. Later changes are owned by the caller.
    initialDoc?: string;
}

export const CodeMirrorSearchExtensions: Extension[] = [
    search({ top: true }),
    keymap.of(searchKeymap),
];

export function createCodeMirrorExtensions(): Extension[] {
    // See: https://github.com/codemirror/basic-setup/blob/main/src/codemirror.ts
    // We might want to add other plugins later.
    const keymapExtension = keymap.of([
        ...defaultKeymap,
        ...historyKeymap
    ]);
    const extensions: Extension[] = [
        themes.xcode.xcodeLight,
        lineNumbers(),
        drawSelection(),
        history(),
        ...DashQLExtensions,
        ...CodeMirrorSearchExtensions,
        keymapExtension
    ];
    return extensions;
}

export function createReadonlyCodeMirrorExtensions(): Extension[] {
    return [
        themes.xcode.xcodeLight,
        lineNumbers(),
        drawSelection(),
        EditorState.readOnly.of(true),
        ...DashQLReadonlyExtensions,
        ...CodeMirrorSearchExtensions,
    ];
}

export const CodeMirror = React.forwardRef<EditorView, CodeMirrorProps>((props: CodeMirrorProps, ref) => {
    const logger = useLogger();

    const [node, setNode] = React.useState<HTMLDivElement | null>(null);

    React.useEffect(() => {
        // Not mounted yet?
        // Then do nothing.
        if (node == null) {
            return () => { };
        }
        logger.debug("Creating a new codemirror view", {}, "codemirror");

        // The DOM node has changed, create a new view
        const extensions = props.extensions == null
            ? [...createCodeMirrorExtensions(), ...(props.extraExtensions ?? [])]
            : [...props.extensions, ...CodeMirrorSearchExtensions];
        const view = new EditorView({
            state: EditorState.create({ doc: props.initialDoc, extensions }),
            parent: node,
            root: props.root,
        });

        // Forward the ref
        if (typeof ref === 'function') {
            ref(view);
        } else if (ref) {
            ref.current = view;
        }

        // Destroy the view when unmounting
        return () => {
            view.destroy();
        };
    }, [node, ref]);


    return <div style={{ width: '100%', height: '100%', ...props.style }} ref={setNode}></div>;
});
