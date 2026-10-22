import * as React from 'react';
import * as core from '@ankoh/dashql-core';
import * as styles from './session_composer.module.css';

import type { EditorView } from '@codemirror/view';

import { ButtonSize, ButtonVariant, IconButton } from '../../../../ui/foundations/button.js';
import { SegmentedControl, SegmentedControlSize } from '../../../../ui/foundations/segmented_control.js';
import { CodeIcon, PaperAirplaneIcon, SymbolIcon } from '../../../../ui/foundations/symbol_icon.js';
import { PromptEditor } from '../../scripts/editor/prompt_editor.js';
import { DashQLCompletionAbortEffect } from '../../scripts/editor/dashql_processor.js';
import { ComposerInputMode } from '../../ai/input_mode.js';
import { useComposerInputMode } from '../../ai/use_composer_input_mode.js';

const SparklesFillIcon = SymbolIcon('sparkles_fill_16');

/// Where the composer is shown
export enum SessionComposerVariant {
    /// Docked below the feed of a session with scripts
    Docked,
    /// Centered on the landing view of an empty session
    Hero,
}

export interface SessionComposerProps {
    /// The DashQL instance that creates the draft session
    instance: core.DashQL;
    /// The connection catalog the draft is analyzed and completed against
    catalog: core.DashQLCatalog;
    /// Where the composer is shown
    variant: SessionComposerVariant;
    /// The keyword case for completions
    keywordCase: core.buffers.formatting.KeywordCase;
    /// Is an AI provider configured? Without one, the composer only takes SQL.
    aiAvailable: boolean;
    /// Called with the draft and its input mode when the user sends it, the draft is cleared before
    onSend: (text: string, mode: ComposerInputMode) => void;
    /// Receives the editor view once it is mounted
    setView?: (view: EditorView | null) => void;
    /// Receives the send function of the composer, e.g. for global key bindings
    submitRef?: React.RefObject<(() => void) | null>;
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

/// A chat-like input that turns its draft into a new session script.
///
/// The draft is either SQL or a question in natural language that an AI provider translates into SQL,
/// see useComposerInputMode.
///
/// The draft lives in its own script session on the connection catalog. It provides completion and tells SQL
/// from natural language, but it is not a session script: it is neither persisted nor loaded into the catalog.
export const SessionComposer: React.FC<SessionComposerProps> = (props) => {
    const [scriptSession, setScriptSession] = React.useState<core.DashQLScriptSession | null>(null);
    React.useEffect(() => {
        const draftSession = props.instance.createScriptSession(props.catalog);
        setScriptSession(draftSession);
        return () => {
            setScriptSession(null);
            draftSession.destroy();
        };
    }, [props.instance, props.catalog]);

    const [view, setView] = React.useState<EditorView | null>(null);
    const [empty, setEmpty] = React.useState(true);
    const handleView = React.useCallback((next: EditorView | null) => {
        setView(next);
        props.setView?.(next);
    }, [props.setView]);

    // The draft is SQL or natural language
    const input = useComposerInputMode(props.catalog, props.aiAvailable);
    const handleTextChange = React.useCallback((text: string) => {
        setEmpty(text.trim().length === 0);
        input.onTextChange(text);
    }, [input.onTextChange]);
    const handleModeChange = React.useCallback((index: number) => {
        input.pick(index === 0 ? ComposerInputMode.Sql : ComposerInputMode.Ai);
    }, [input.pick]);

    const send = React.useCallback(() => {
        if (view == null) return;
        const mode = input.resolveSendMode();
        const text = takeComposerDraft(view);
        if (text != null) {
            props.onSend(text, mode);
        }
    }, [props.onSend, view, input.resolveSendMode]);
    const handleSendClick = React.useCallback(() => {
        send();
        view?.focus();
    }, [send, view]);
    if (props.submitRef) {
        props.submitRef.current = send;
    }

    // The landing view is all about the prompt, focus it right away
    const hero = props.variant === SessionComposerVariant.Hero;
    React.useEffect(() => {
        if (hero) view?.focus();
    }, [view]);

    const naturalLanguage = input.mode === ComposerInputMode.Ai;
    const placeholder = naturalLanguage
        ? 'Ask a question about your data'
        : (hero ? 'select * from ...' : 'Write a query, press Enter to run it');
    return (
        <div className={styles.composer} data-variant={hero ? 'hero' : 'docked'}>
            <PromptEditor
                className={styles.composer_editor}
                scriptSession={scriptSession}
                placeholder={placeholder}
                keywordCase={props.keywordCase}
                assist={input.assist}
                onSubmit={send}
                onTextChange={handleTextChange}
                onEditorUpdate={input.onEditorUpdate}
                setView={handleView}
            />
            <div className={styles.composer_action_bar}>
                <SegmentedControl aria-label="Input mode" size={SegmentedControlSize.Small} onChange={handleModeChange}>
                    <SegmentedControl.Button leadingVisual={CodeIcon} selected={!naturalLanguage}>
                        SQL
                    </SegmentedControl.Button>
                    <SegmentedControl.Button
                        leadingVisual={SparklesFillIcon}
                        selected={naturalLanguage}
                        disabled={!props.aiAvailable}
                        title={props.aiAvailable ? undefined : 'Configure an AI provider in the settings to ask questions'}
                    >
                        AI
                    </SegmentedControl.Button>
                </SegmentedControl>
                <IconButton
                    variant={hero ? ButtonVariant.Primary : ButtonVariant.Default}
                    size={ButtonSize.Small}
                    aria-label={naturalLanguage ? 'Ask AI' : 'Run query'}
                    disabled={empty}
                    onClick={handleSendClick}
                >
                    <PaperAirplaneIcon />
                </IconButton>
            </div>
        </div>
    );
};
