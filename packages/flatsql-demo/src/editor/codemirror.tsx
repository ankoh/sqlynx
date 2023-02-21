// Significant portions of this file have been derived from @uiwjs/react-codemirror

import React, { useRef, forwardRef, useImperativeHandle } from 'react';
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

export const CodeMirror = forwardRef<CodeMirrorRef, CodeMirrorProps>((props, ref) => {
    const {
        className,
        value = '',
        selection,
        extensions = [],
        onChange,
        onCreateEditor,
        onUpdate,
        autoFocus,
        height,
        minHeight,
        maxHeight,
        width,
        minWidth,
        maxWidth,
        placeholder,
        editable,
        readOnly,
        root,
        ...other
    } = props;
    const editor = useRef<HTMLDivElement>(null);
    const { state, view, container } = useCodeMirror({
        container: editor.current,
        root,
        value,
        autoFocus,
        height,
        minHeight,
        maxHeight,
        width,
        minWidth,
        maxWidth,
        placeholder,
        editable,
        readOnly,
        selection,
        onChange,
        onCreateEditor,
        onUpdate,
        extensions,
    });
    useImperativeHandle(ref, () => ({ editor: editor.current, state: state, view: view }), [
        editor,
        container,
        state,
        view,
    ]);
    return <div ref={editor} {...other}></div>;
});

interface UseCodeMirror extends CodeMirrorProps {
    container?: HTMLDivElement | null;
}

function useCodeMirror(props: UseCodeMirror) {
    const {
        value,
        selection,
        onChange,
        onCreateEditor,
        onUpdate,
        extensions = [],
        autoFocus,
        height = '',
        minHeight = '',
        maxHeight = '',
        placeholder: placeholderStr = '',
        width = '',
        minWidth = '',
        maxWidth = '',
        editable = true,
        readOnly = false,
        root,
    } = props;

    // Setup react state
    const [container, setContainer] = useState<HTMLDivElement>();
    const [view, setView] = useState<EditorView>();
    const [state, setState] = useState<EditorState>();

    const themeOption = EditorView.theme(
        {
            '&': {
                backgroundColor: 'transparent',
                height,
                minHeight,
                maxHeight,
                width,
                minWidth,
                maxWidth,
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
            typeof onChange === 'function' &&
            // Fix echoing of the remote changes:
            // If transaction is market as remote we don't have to call `onChange` handler again
            !vu.transactions.some(tr => tr.annotation(External))
        ) {
            const doc = vu.state.doc;
            const value = doc.toString();
            onChange(value, vu);
        }
    });

    // Build extensions
    let getExtensions = [updateListener, themeOption];
    if (placeholderStr) {
        getExtensions.unshift(placeholder(placeholderStr));
    }
    if (editable === false) {
        getExtensions.push(EditorView.editable.of(false));
    }
    if (readOnly) {
        getExtensions.push(EditorState.readOnly.of(true));
    }
    if (onUpdate && typeof onUpdate === 'function') {
        getExtensions.push(EditorView.updateListener.of(onUpdate));
    }
    getExtensions = getExtensions.concat(extensions);

    // Create EditorView if it does not exist
    useEffect(() => {
        if (container && !state) {
            const config = {
                doc: value,
                selection,
                extensions: getExtensions,
            };
            const stateCurrent = EditorState.create(config);
            setState(stateCurrent);
            if (!view) {
                const viewCurrent = new EditorView({
                    state: stateCurrent,
                    parent: container,
                    root,
                });
                setView(viewCurrent);
                onCreateEditor && onCreateEditor(viewCurrent, stateCurrent);
            }
        }
        return () => {
            if (view) {
                setState(undefined);
                setView(undefined);
            }
        };
    }, [container, state]);

    // Set the div element
    useEffect(() => setContainer(props.container!), [props.container]);
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
        if (autoFocus && view) {
            view.focus();
        }
    }, [autoFocus, view]);

    // Reconfigure extensions
    useEffect(() => {
        if (view) {
            view.dispatch({ effects: StateEffect.reconfigure.of(getExtensions) });
        }
    }, [
        extensions,
        height,
        minHeight,
        maxHeight,
        width,
        minWidth,
        maxWidth,
        placeholderStr,
        editable,
        readOnly,
        onChange,
        onUpdate,
    ]);

    // Check view value if the props value changes
    useEffect(() => {
        if (value === undefined) {
            return;
        }
        const currentValue = view ? view.state.doc.toString() : '';
        if (view && value !== currentValue) {
            view.dispatch({
                changes: { from: 0, to: currentValue.length, insert: value || '' },
                annotations: [External.of(true)],
            });
        }
    }, [value, view]);

    return { state, setState, view, setView, container, setContainer };
}