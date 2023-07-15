import React from 'react';
import { EditorState, EditorStateConfig, Extension, Annotation, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import './codemirror.css';

export interface CodeMirrorProps
    extends Omit<EditorStateConfig, 'doc' | 'extensions'>,
        Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange' | 'placeholder'> {
    /// Callback after view is initially created
    viewWasCreated?: (view: EditorView) => void;
    /// Callback before view is destroyed
    viewWillBeDestroyed?: (view: EditorView) => void;

    /// The codemirror extensions
    extensions?: Extension[];
    /// Root of the DOM where the editor is mounted
    root?: ShadowRoot | Document;
}

interface ViewMountState {
    view: EditorView | null;
    node: HTMLDivElement | null;
    extensions: Extension[];
    viewWasCreated: ((view: EditorView) => void) | null;
    viewWillBeDestroyed: ((view: EditorView) => void) | null;
}

export const CodeMirror: React.FC<CodeMirrorProps> = (props: CodeMirrorProps) => {
    /// Maintain the view DOM node
    const mount = React.useRef<ViewMountState>({
        view: null,
        node: null,
        extensions: props.extensions ?? [],
        viewWasCreated: props.viewWasCreated ?? null,
        viewWillBeDestroyed: props.viewWillBeDestroyed ?? null,
    });
    // Make the ref callback dependency-less through RefObject + effect
    React.useEffect(() => {
        mount.current.extensions = props.extensions ?? [];
        mount.current.viewWasCreated = props.viewWasCreated ?? null;
        mount.current.viewWillBeDestroyed = props.viewWillBeDestroyed ?? null;
    }, [props.extensions, props.viewWasCreated, props.viewWillBeDestroyed]);

    const onRefChange = React.useCallback((node: HTMLDivElement) => {
        // DOM node stayed the same, nothing to do.
        if (node != null && node === mount.current!.node) {
            return;
        }
        // Is there a view?
        if (mount.current.view !== null) {
            if (props.viewWillBeDestroyed) {
                props.viewWillBeDestroyed(mount.current.view);
            }
            mount.current.view.destroy();
            mount.current.view = null;
        }
        mount.current.node = node;

        // Has the DOM node been unmounted?
        // Then we don't need to create a new view.
        if (node === null) {
            return;
        }
        // The DOM node has changed, create a new view
        mount.current.view = new EditorView({
            state: EditorState.create({ extensions: mount.current.extensions }),
            parent: node,
            root: props.root,
        });
        if (props.viewWasCreated) {
            props.viewWasCreated(mount.current.view);
        }
    }, []);
    return <div style={{ width: '100%', height: '100%' }} ref={onRefChange}></div>;
};
