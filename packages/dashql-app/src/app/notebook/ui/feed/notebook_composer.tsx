import * as React from 'react';
import * as core from '@ankoh/dashql-core';
import * as styles from './notebook_composer.module.css';

import type { EditorView } from '@codemirror/view';

import { ButtonSize, ButtonVariant, IconButton } from '../../../../ui/foundations/button.js';
import { SegmentedControl, SegmentedControlSize } from '../../../../ui/foundations/segmented_control.js';
import { CodeIcon, PaperAirplaneIcon, SymbolIcon } from '../../../../ui/foundations/symbol_icon.js';
import { PromptEditor } from '../../scripts/editor/prompt_editor.js';
import { DashQLCompletionAbortEffect } from '../../scripts/editor/dashql_processor.js';
import { buildCatalogNameIndex, CatalogNameIndex, EMPTY_CATALOG_NAME_INDEX } from '../../ai/catalog_name_index.js';
import { assessSql, ComposerInputMode, decideMode } from './composer_input_mode.js';
import { useLogger } from '../../../../platform/logger/logger_provider.js';

const LOG_CTX = 'notebook_composer';
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

/// A chat-like input that turns its draft into a new notebook script.
///
/// The draft is either SQL or a question in natural language that an AI provider translates into SQL.
/// The composer starts in natural language and switches to SQL as soon as the draft is convincingly SQL,
/// until the user picks a mode explicitly.
///
/// The draft lives in its own script session on the connection catalog. It provides completion and tells SQL
/// from natural language, but it is not a notebook script: it is neither persisted nor loaded into the catalog.
export const NotebookComposer: React.FC<NotebookComposerProps> = (props) => {
    const logger = useLogger();
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

    // The input mode follows the draft until the user picks one.
    // The ref holds the latest mode for the editor callbacks that decide the next one.
    const [mode, setModeState] = React.useState(ComposerInputMode.Ai);
    const modeRef = React.useRef(mode);
    const modeOverridden = React.useRef(false);
    const setMode = React.useCallback((next: ComposerInputMode, reason: string, details: Record<string, string> = {}) => {
        if (modeRef.current === next) return;
        logger.debug('Switched the composer input mode', { mode: ComposerInputMode[next], reason, ...details }, LOG_CTX);
        modeRef.current = next;
        setModeState(next);
    }, [logger]);
    const effectiveMode = props.aiAvailable ? mode : ComposerInputMode.Sql;
    const handleTextChange = React.useCallback((text: string) => {
        const blank = text.trim().length === 0;
        setEmpty(blank);
        if (blank) {
            setMode(ComposerInputMode.Ai, 'cleared');
            modeOverridden.current = false;
        }
    }, [setMode]);
    const handleModeChange = React.useCallback((index: number) => {
        setMode(index === 0 ? ComposerInputMode.Sql : ComposerInputMode.Ai, 'picked');
        modeOverridden.current = true;
    }, [setMode]);

    // The catalog names that are highlighted and completed in natural language.
    // Rebuilt only when the catalog changes, the snapshot is cached by the catalog.
    const [identifierIndex, setIdentifierIndex] = React.useState<CatalogNameIndex>(EMPTY_CATALOG_NAME_INDEX);
    const indexedSnapshot = React.useRef<core.DashQLCatalogSnapshot | null>(null);
    const refreshIdentifierIndex = React.useCallback(() => {
        const snapshot = props.catalog.createSnapshot();
        if (snapshot === indexedSnapshot.current) return;
        indexedSnapshot.current = snapshot;
        const index = buildCatalogNameIndex(snapshot.read());
        logger.debug('Built the catalog name index of the composer', { names: String(index.keys.length) }, LOG_CTX);
        setIdentifierIndex(index);
    }, [props.catalog, logger]);
    React.useEffect(() => {
        if (props.aiAvailable) refreshIdentifierIndex();
    }, [props.aiAvailable, refreshIdentifierIndex]);

    // Every edit of the draft re-evaluates the mode.
    // The token at the cursor is still being typed and does not count yet.
    const lastUpdate = React.useRef<core.buffers.editor.EditorUpdateT | null>(null);
    const latest = React.useRef({ aiAvailable: props.aiAvailable, refreshIdentifierIndex });
    latest.current = { aiAvailable: props.aiAvailable, refreshIdentifierIndex };
    const handleEditorUpdate = React.useCallback((update: core.buffers.editor.EditorUpdateT) => {
        const prev = lastUpdate.current;
        lastUpdate.current = update;
        if (!latest.current.aiAvailable) return;
        if (prev == null || prev.catalogRevision !== update.catalogRevision) {
            latest.current.refreshIdentifierIndex();
        }
        if (!update.textChanged || modeOverridden.current) return;
        const cursor = update.primarySelection != null ? Number(update.primarySelection.head) : null;
        const evidence = assessSql(update, cursor);
        setMode(decideMode(modeRef.current, evidence), 'detected', {
            validTokens: String(evidence.validTokens),
            tailTokens: String(evidence.tailTokens),
        });
    }, [setMode]);

    const send = React.useCallback(() => {
        if (view == null) return;
        // The draft is final now, every token counts
        let sendMode = effectiveMode;
        if (props.aiAvailable && !modeOverridden.current && lastUpdate.current != null) {
            sendMode = decideMode(effectiveMode, assessSql(lastUpdate.current, null), true);
            setMode(sendMode, 'sent');
        }
        const text = takeComposerDraft(view);
        if (text != null) {
            props.onSend(text, sendMode);
        }
    }, [props.onSend, props.aiAvailable, view, effectiveMode, setMode]);
    const handleSendClick = React.useCallback(() => {
        send();
        view?.focus();
    }, [send, view]);
    if (props.submitRef) {
        props.submitRef.current = send;
    }

    // The landing view is all about the prompt, focus it right away
    const hero = props.variant === NotebookComposerVariant.Hero;
    React.useEffect(() => {
        if (hero) view?.focus();
    }, [view]);

    const naturalLanguage = effectiveMode === ComposerInputMode.Ai;
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
                naturalLanguage={naturalLanguage}
                identifierIndex={identifierIndex}
                onSubmit={send}
                onTextChange={handleTextChange}
                onEditorUpdate={handleEditorUpdate}
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
