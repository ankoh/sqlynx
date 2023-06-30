// Significant portions of this file have been derived from @uiwjs/react-codemirror

import React, { useRef } from 'react';
import { EditorState, EditorStateConfig, Extension, Annotation, StateEffect } from '@codemirror/state';
import { EditorView, ViewUpdate, placeholder } from '@codemirror/view';
import { useEffect, useState } from 'react';

const External = Annotation.define<boolean>();

export interface CodeMirrorProps
    extends Omit<EditorStateConfig, 'doc' | 'extensions'>,
        Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange' | 'placeholder'> {
    /// The editor value
    value?: string;
    /// The editor height
    height?: string;
    /// The minimum height of the editor
    minHeight?: string;
    /// The maximum height of the editor
    maxHeight?: string;
    /// The editor width
    width?: string;
    /// The minimum width of the editor
    minWidth?: string;
    /// The maximum height of the editor
    maxWidth?: string;
    /// Focus on the editor automatically
    autoFocus?: boolean;
    /// Placeholder to show when the editor is empty
    placeholder?: string | HTMLElement;
    /// Is the editor editable?
    editable?: boolean;
    /// Is the editor readonly?
    readOnly?: boolean;

    /// Called whenever the value changes
    onChange?(value: string, viewUpdate: ViewUpdate): void;
    /// Called on editor events
    onUpdate?(viewUpdate: ViewUpdate): void;
    /// Initial callback
    onCreateEditor?(view: EditorView, state: EditorState): void;

    /// The codemirror extensions
    extensions?: Extension[];
    /// Root of the DOM where the editor is mounted
    root?: ShadowRoot | Document;
}

export interface CodeMirrorRef {
    editor?: HTMLDivElement | null;
    state?: EditorState;
    view?: EditorView;
}

export const CodeMirror: React.FC<CodeMirrorProps> = (props: CodeMirrorProps) => {
    // Setup react state
    const editor = useRef<HTMLDivElement>(null);
    const [container, setContainer] = useState<HTMLDivElement>();
    const [view, setView] = useState<EditorView>();
    const [state, setState] = useState<EditorState>();

    // Create editor theme
    const themeOption = EditorView.theme(
        {
            '&': {
                backgroundColor: 'transparent',
                height: props.height ?? null,
                minHeight: props.minHeight ?? null,
                maxHeight: props.maxHeight ?? null,
                width: props.width ?? null,
                minWidth: props.maxWidth ?? null,
                maxWidth: props.maxWidth ?? null,
            },
            '&.cm-editor': {
                outline: 'none !important',
            },
            '&.cm-editor-focused': {},
        },
        {
            dark: false,
        },
    );

    const updateListener = EditorView.updateListener.of((vu: ViewUpdate) => {
        if (
            vu.docChanged &&
            typeof props.onChange === 'function' &&
            // Fix echoing of the remote changes:
            // If transaction is market as remote we don't have to call `onChange` handler again
            !vu.transactions.some(tr => tr.annotation(External))
        ) {
            const doc = vu.state.doc;
            const value = doc.toString();
            props.onChange(value, vu);
        }
    });

    // Build extensions
    let extensions = [updateListener, themeOption];
    if (props.placeholder) {
        extensions.unshift(placeholder(props.placeholder));
    }
    if (props.editable === false) {
        extensions.push(EditorView.editable.of(false));
    }
    if (props.readOnly) {
        extensions.push(EditorState.readOnly.of(true));
    }
    if (props.onUpdate && typeof props.onUpdate === 'function') {
        extensions.push(EditorView.updateListener.of(props.onUpdate));
    }
    if (props.extensions) {
        extensions.push(props.extensions);
    }

    // Create EditorView if it does not exist
    useEffect(() => {
        if (container && !state) {
            const config = {
                doc: props.value,
                selection: props.selection,
                extensions: extensions,
            };
            const stateCurrent = EditorState.create(config);
            setState(stateCurrent);
            if (!view) {
                const viewCurrent = new EditorView({
                    state: stateCurrent,
                    parent: container,
                    root: props.root,
                });
                setView(viewCurrent);
                props.onCreateEditor && props.onCreateEditor(viewCurrent, stateCurrent);
            }
        }
        return () => {
            if (view) {
                setState(undefined);
                setView(undefined);
            }
        };
    }, [container, state]);

    // Maintain editor state
    useEffect(() => setContainer(editor.current!), [editor.current]);
    // Delete the editor view when destroyed
    useEffect(
        () => () => {
            if (view) {
                view.destroy();
                setView(undefined);
            }
        },
        [view],
    );
    // Autofocus the editor view, if requested
    useEffect(() => {
        if (props.autoFocus && view) {
            view.focus();
        }
    }, [props.autoFocus, view]);

    // Reconfigure the state whenever properties change
    useEffect(() => {
        if (view) {
            view.dispatch({ effects: StateEffect.reconfigure.of(extensions) });
        }
    }, [
        props.extensions,
        props.height,
        props.minHeight,
        props.maxHeight,
        props.width,
        props.minWidth,
        props.maxWidth,
        props.placeholder,
        props.editable,
        props.readOnly,
        props.onChange,
        props.onUpdate,
    ]);

    // Check view value if the props value changes
    useEffect(() => {
        if (props.value === undefined) {
            return;
        }
        const currentValue = view ? view.state.doc.toString() : '';
        if (view && props.value !== currentValue) {
            view.dispatch({
                changes: { from: 0, to: currentValue.length, insert: props.value || '' },
                annotations: [External.of(true)],
            });
        }
    }, [props.value, view]);

    return <div ref={editor}></div>;
};
