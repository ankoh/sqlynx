import * as React from 'react';
import * as core from '@ankoh/dashql-core';
import * as styles from './notebook_composer.module.css';

import type { EditorView } from '@codemirror/view';

import { ButtonSize, ButtonVariant, IconButton } from '../../../../ui/foundations/button.js';
import { SegmentedControl, SegmentedControlSize } from '../../../../ui/foundations/segmented_control.js';
import { CodeIcon, PaperAirplaneIcon, SymbolIcon } from '../../../../ui/foundations/symbol_icon.js';
import { PromptEditor } from '../../scripts/editor/prompt_editor.js';
import { DashQLCompletionAbortEffect } from '../../scripts/editor/dashql_processor.js';

const SparklesFillIcon = SymbolIcon('sparkles_fill_16');

/// Where the composer is shown
export enum NotebookComposerVariant {
    /// Docked below the feed of a notebook with scripts
    Docked,
    /// Centered on the landing view of an empty notebook
    Hero,
}

export interface NotebookComposerProps {
    /// The DashQL instance that creates the draft session
    instance: core.DashQL;
    /// The connection catalog the draft is analyzed and completed against
    catalog: core.DashQLCatalog;
    /// Where the composer is shown
    variant: NotebookComposerVariant;
    /// The keyword case for completions
    keywordCase: core.buffers.formatting.KeywordCase;
    /// Called with the draft text when the user sends it, the draft is cleared before
    onSend: (text: string) => void;
    /// Receives the editor view once it is mounted
    setView?: (view: EditorView | null) => void;
}

/// Takes the draft out of a composer editor and clears it, returns null when the draft is blank
export function takeComposerDraft(view: EditorView): string | null {
    const text = view.state.doc.toString();
    if (text.trim().length === 0) {
        return null;
    }
    // Drop an open completion together with the text it points into
    view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: '' },
        effects: DashQLCompletionAbortEffect.of(null),
    });
    return text;
}

/// A chat-like SQL input that turns its draft into a new notebook script.
///
/// The draft lives in its own script session on the connection catalog. It provides completion but
/// is not a notebook script: it is neither persisted nor loaded into the catalog.
export const NotebookComposer: React.FC<NotebookComposerProps> = (props) => {
    const [scriptSession, setScriptSession] = React.useState<core.DashQLScriptSession | null>(null);
    React.useEffect(() => {
        const session = props.instance.createScriptSession(props.catalog);
        setScriptSession(session);
        return () => {
            setScriptSession(null);
            session.destroy();
        };
    }, [props.instance, props.catalog]);

    const [view, setView] = React.useState<EditorView | null>(null);
    const [empty, setEmpty] = React.useState(true);
    const handleView = React.useCallback((next: EditorView | null) => {
        setView(next);
        props.setView?.(next);
    }, [props.setView]);
    const handleTextChange = React.useCallback((text: string) => setEmpty(text.trim().length === 0), []);

    const send = React.useCallback(() => {
        const text = view != null ? takeComposerDraft(view) : null;
        if (text != null) {
            props.onSend(text);
        }
    }, [props.onSend, view]);
    const handleSendClick = React.useCallback(() => {
        send();
        view?.focus();
    }, [send, view]);

    // The landing view is all about the prompt, focus it right away
    const hero = props.variant === NotebookComposerVariant.Hero;
    React.useEffect(() => {
        if (hero) view?.focus();
    }, [view]);

    return (
        <div className={styles.composer} data-variant={hero ? 'hero' : 'docked'}>
            <PromptEditor
                className={styles.composer_editor}
                scriptSession={scriptSession}
                placeholder={hero ? 'select * from ...' : 'Write a query, press Enter to run it'}
                keywordCase={props.keywordCase}
                onSubmit={send}
                onTextChange={handleTextChange}
                setView={handleView}
            />
            <div className={styles.composer_action_bar}>
                <SegmentedControl aria-label="Input mode" size={SegmentedControlSize.Small}>
                    <SegmentedControl.Button leadingVisual={CodeIcon} selected>SQL</SegmentedControl.Button>
                    <SegmentedControl.Button leadingVisual={SparklesFillIcon} disabled count="Soon">AI</SegmentedControl.Button>
                </SegmentedControl>
                <IconButton
                    variant={hero ? ButtonVariant.Primary : ButtonVariant.Default}
                    size={ButtonSize.Small}
                    aria-label="Run query"
                    disabled={empty}
                    onClick={handleSendClick}
                >
                    <PaperAirplaneIcon />
                </IconButton>
            </div>
        </div>
    );
};
