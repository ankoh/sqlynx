import * as React from 'react';
import * as dashql from '@ankoh/dashql-core';
import * as themes from './themes/index.js';

import { Compartment, EditorState, Extension, Prec } from '@codemirror/state';
import { EditorView, drawSelection, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, insertNewlineAndIndent } from '@codemirror/commands';

import { CodeMirrorSearchExtensions } from './codemirror.js';
import { DashQLExtensions, DashQLFocusCompletionEffect } from './dashql_extension.js';
import { DashQLCompletionAbortEffect, DashQLCompletionDisabled, DashQLProcessorPlugin, DashQLProcessorUpdateOut, DashQLUpdateEffect } from './dashql_processor.js';
import { NLIdentifierExtensions, NLIdentifierIndex, NLIdentifierIndexEffect } from './nl_identifier_plugin.js';
import { replaceScriptSessionText } from '../notebook_scripts.js';
import type { CatalogNameIndex } from '../../ai/catalog_name_index.js';

/// Callbacks of the prompt editor, read through a ref so the editor extensions are built only once.
interface PromptEditorCallbacks {
    /// Called with the current text when the user submits the prompt
    onSubmit?: (text: string) => void;
    /// Called with the current text whenever the document changes
    onTextChange?: (text: string) => void;
    /// Called with every editor update of the script session
    onEditorUpdate?: (update: dashql.buffers.editor.EditorUpdateT) => void;
}

/// The SQL assistance: completion, highlighting and auto-closing.
/// An empty prompt shows its placeholder rather than a completion hint.
const SQL_ASSIST_EXTENSIONS = DashQLExtensions.filter(extension => extension !== DashQLFocusCompletionEffect && extension !== DashQLProcessorPlugin);
/// The assistance for natural language: no SQL completion, catalog identifiers are highlighted and completed
const NATURAL_LANGUAGE_EXTENSIONS = [DashQLCompletionDisabled.of(true), ...NLIdentifierExtensions];

/// Create CodeMirror extensions for a prompt editor.
/// This is a minimal setup without line numbers and gutters that grows with its content.
/// It scrolls beyond its maximum height and along long lines without showing scrollbars.
/// Enter submits, Shift+Enter inserts a newline.
function createPromptExtensions(configurable: Extension[], callbacks: React.RefObject<PromptEditorCallbacks>): Extension[] {
    const submit = (view: EditorView) => {
        const text = view.state.doc.toString();
        if (text.trim().length > 0) {
            callbacks.current?.onSubmit?.(text);
        }
        return true;
    };
    return [
        themes.xcode.xcodeLight,
        drawSelection(),
        history(),
        // The processor keeps running in every mode, the script session tells SQL from natural language
        DashQLProcessorPlugin,
        NLIdentifierIndex,
        ...CodeMirrorSearchExtensions,
        // Below the completion keymap (Prec.highest), above the default Enter binding
        Prec.high(keymap.of([
            { key: 'Enter', run: submit },
            { key: 'Mod-Enter', run: submit },
            { key: 'Shift-Enter', run: insertNewlineAndIndent },
        ])),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        ...configurable,
        EditorView.updateListener.of(update => {
            if (update.docChanged) {
                callbacks.current?.onTextChange?.(update.state.doc.toString());
            }
        }),
        EditorView.theme({
            '&': { minHeight: '24px', backgroundColor: 'transparent' },
            '&.cm-focused': { outline: 'none' },
            '.cm-scroller': { overflow: 'auto', maxHeight: 'var(--prompt_editor_max_height, 40vh)', scrollbarWidth: 'none' },
            '.cm-content': { minHeight: '24px', padding: '0' },
            '.cm-line': { padding: '0' },
            '.cm-gutters': { display: 'none' },
        }),
    ];
}

export interface PromptEditorProps {
    /// The script session that backs analysis and completion, null while it is being set up
    scriptSession: dashql.DashQLScriptSession | null;
    /// The text shown while the prompt is empty
    placeholder: string;
    /// The keyword case for completions
    keywordCase?: dashql.buffers.formatting.KeywordCase;
    /// The class name of the container
    className?: string;
    /// Called with the current text when the user submits the prompt
    onSubmit?: (text: string) => void;
    /// Called with the current text whenever the document changes
    onTextChange?: (text: string) => void;
    /// Called with every editor update of the script session, e.g. to tell SQL from natural language
    onEditorUpdate?: (update: dashql.buffers.editor.EditorUpdateT) => void;
    /// Does the prompt hold natural language rather than SQL?
    naturalLanguage?: boolean;
    /// The catalog names that are highlighted and completed in natural language
    identifierIndex?: CatalogNameIndex;
    /// Receives the CodeMirror view once it is mounted
    setView?: (view: EditorView | null) => void;
}

/// A minimal SQL prompt backed by CodeMirror and wired with a DashQL script session.
///
/// The session belongs to the caller. It is not a notebook script, so analysis results are kept
/// local to the editor and never loaded into the catalog.
export const PromptEditor: React.FC<PromptEditorProps> = (props) => {
    const callbacks = React.useRef<PromptEditorCallbacks>({});
    callbacks.current = { onSubmit: props.onSubmit, onTextChange: props.onTextChange, onEditorUpdate: props.onEditorUpdate };

    // Create the CodeMirror view when the DOM node is mounted
    const [editorNode, setEditorNode] = React.useState<HTMLDivElement | null>(null);
    const [editorView, setEditorView] = React.useState<EditorView | null>(null);
    const compartments = React.useMemo(() => ({
        placeholder: new Compartment(),
        assist: new Compartment(),
    }), []);
    React.useEffect(() => {
        if (editorNode == null) {
            return;
        }
        const configurable = [
            compartments.placeholder.of(placeholder(props.placeholder)),
            compartments.assist.of(props.naturalLanguage ? NATURAL_LANGUAGE_EXTENSIONS : SQL_ASSIST_EXTENSIONS),
        ];
        const view = new EditorView({
            state: EditorState.create({ extensions: createPromptExtensions(configurable, callbacks) }),
            parent: editorNode,
        });
        if (props.identifierIndex != null) {
            view.dispatch({ effects: NLIdentifierIndexEffect.of(props.identifierIndex) });
        }
        setEditorView(view);
        return () => {
            view.destroy();
            setEditorView(null);
        };
    }, [editorNode]);

    // Swap the placeholder and the assistance without recreating the view
    React.useEffect(() => {
        editorView?.dispatch({ effects: compartments.placeholder.reconfigure(placeholder(props.placeholder)) });
    }, [editorView, props.placeholder]);
    React.useEffect(() => {
        if (editorView == null) return;
        const naturalLanguage = props.naturalLanguage ?? false;
        const current = compartments.assist.get(editorView.state);
        const next = naturalLanguage ? NATURAL_LANGUAGE_EXTENSIONS : SQL_ASSIST_EXTENSIONS;
        if (current === next) return;
        editorView.dispatch({
            effects: [
                compartments.assist.reconfigure(next),
                // A SQL completion makes no sense in natural language
                ...(naturalLanguage ? [DashQLCompletionAbortEffect.of(null)] : []),
            ],
        });
    }, [editorView, props.naturalLanguage]);
    React.useEffect(() => {
        if (editorView == null || props.identifierIndex == null) return;
        if (editorView.state.field(NLIdentifierIndex) === props.identifierIndex) return;
        editorView.dispatch({ effects: NLIdentifierIndexEffect.of(props.identifierIndex) });
    }, [editorView, props.identifierIndex]);

    // Forward the view
    React.useEffect(() => {
        props.setView?.(editorView);
    }, [editorView, props.setView]);

    // The processor keeps its own state, we only release the completion buffers it superseded
    const completion = React.useRef<DashQLProcessorUpdateOut['scriptCompletion']>(null);
    const releaseCompletion = React.useCallback((next: DashQLProcessorUpdateOut['scriptCompletion']) => {
        if (completion.current != null && completion.current.buffer !== next?.buffer) {
            completion.current.buffer.destroy();
        }
        completion.current = next;
    }, []);
    React.useEffect(() => () => releaseCompletion(null), [editorView]);

    // Bind the script session to the editor.
    // A new session (e.g. after the connection catalog changed) takes over the current text.
    React.useEffect(() => {
        const scriptSession = props.scriptSession;
        if (editorView == null || scriptSession == null) {
            return;
        }
        const text = editorView.state.doc.toString();
        if (scriptSession.getText() !== text) {
            replaceScriptSessionText(scriptSession, text);
        }
        // A different session drops the completion of the previous one
        const onUpdate = (update: DashQLProcessorUpdateOut) => {
            releaseCompletion(update.scriptCompletion);
            if (update.editorUpdate != null) {
                callbacks.current?.onEditorUpdate?.(update.editorUpdate);
            }
        };
        if (editorView.state.field(DashQLProcessorPlugin).scriptSession !== scriptSession) {
            releaseCompletion(null);
        }
        editorView.dispatch({
            effects: DashQLUpdateEffect.of({
                scriptKey: scriptSession.getCatalogEntryId(),
                scriptSession,
                editorUpdate: scriptSession.analyze(),
                scriptBuffers: null,
                scriptCompletion: null,
                scriptPendingDiff: null,
                derivedFocus: null,
                keywordCase: props.keywordCase,
                onUpdate,
            }),
        });
    }, [editorView, props.scriptSession, props.keywordCase]);

    return <div className={props.className} ref={setEditorNode} />;
};
