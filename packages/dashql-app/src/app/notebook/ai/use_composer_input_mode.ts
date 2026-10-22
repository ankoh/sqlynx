import * as React from 'react';
import * as core from '@ankoh/dashql-core';

import type { Extension } from '@codemirror/state';

import { buildCatalogNameIndex, CatalogNameIndex, EMPTY_CATALOG_NAME_INDEX } from './catalog_name_index.js';
import { naturalLanguageAssist } from './editor/nl_identifier_plugin.js';
import { assessSql, ComposerInputMode, decideMode } from './input_mode.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';

const LOG_CTX = 'composer_input_mode';

/// The input mode of a composer draft
export interface ComposerInputModeState {
    /// The mode of the draft, always SQL without an AI provider
    mode: ComposerInputMode;
    /// The editor assistance of the mode, undefined for the default SQL assistance
    assist: Extension | undefined;
    /// Called with the draft text whenever it changes, a cleared draft starts over in natural language
    onTextChange: (text: string) => void;
    /// Called with every editor update of the draft session, re-evaluates the mode
    onEditorUpdate: (update: core.buffers.editor.EditorUpdateT) => void;
    /// The user picked a mode, it sticks until the draft is cleared
    pick: (mode: ComposerInputMode) => void;
    /// Decide the mode of the draft that is being sent
    resolveSendMode: () => ComposerInputMode;
}

/// Tell SQL from natural language in a composer draft.
///
/// The draft starts in natural language and switches to SQL as soon as it is convincingly SQL,
/// until the user picks a mode explicitly. Natural language highlights and completes the names of the catalog.
export function useComposerInputMode(catalog: core.DashQLCatalog, aiAvailable: boolean): ComposerInputModeState {
    const logger = useLogger();

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
    const onTextChange = React.useCallback((text: string) => {
        if (text.trim().length === 0) {
            setMode(ComposerInputMode.Ai, 'cleared');
            modeOverridden.current = false;
        }
    }, [setMode]);
    const pick = React.useCallback((next: ComposerInputMode) => {
        setMode(next, 'picked');
        modeOverridden.current = true;
    }, [setMode]);

    // The catalog names that are highlighted and completed in natural language.
    // Rebuilt whenever the revision of the catalog moves, null forces a rebuild.
    const [identifierIndex, setIdentifierIndex] = React.useState<CatalogNameIndex>(EMPTY_CATALOG_NAME_INDEX);
    const indexedRevision = React.useRef<bigint | null>(null);
    const refreshIdentifierIndex = React.useCallback((revision: bigint | null) => {
        if (revision != null && revision === indexedRevision.current) return;
        indexedRevision.current = revision;
        const index = buildCatalogNameIndex(catalog);
        logger.debug('Built the catalog name index of the composer', {
            names: String(index.keys.length),
            catalogRevision: revision?.toString() ?? null,
        }, LOG_CTX);
        setIdentifierIndex(index);
    }, [catalog, logger]);
    React.useEffect(() => {
        if (aiAvailable) refreshIdentifierIndex(null);
    }, [aiAvailable, refreshIdentifierIndex]);

    // Every edit of the draft re-evaluates the mode.
    // The token at the cursor is still being typed and does not count yet.
    const lastUpdate = React.useRef<core.buffers.editor.EditorUpdateT | null>(null);
    const latest = React.useRef({ aiAvailable, refreshIdentifierIndex });
    latest.current = { aiAvailable, refreshIdentifierIndex };
    const onEditorUpdate = React.useCallback((update: core.buffers.editor.EditorUpdateT) => {
        lastUpdate.current = update;
        if (!latest.current.aiAvailable) return;
        latest.current.refreshIdentifierIndex(update.catalogRevision);
        if (!update.textChanged || modeOverridden.current) return;
        const cursor = update.primarySelection != null ? Number(update.primarySelection.head) : null;
        const evidence = assessSql(update, cursor);
        setMode(decideMode(modeRef.current, evidence), 'detected', {
            validTokens: String(evidence.validTokens),
            tailTokens: String(evidence.tailTokens),
        });
    }, [setMode]);

    // The draft is final now, every token counts
    const resolveSendMode = React.useCallback(() => {
        if (!latest.current.aiAvailable) return ComposerInputMode.Sql;
        if (modeOverridden.current || lastUpdate.current == null) return modeRef.current;
        const next = decideMode(modeRef.current, assessSql(lastUpdate.current, null), true);
        setMode(next, 'sent');
        return next;
    }, [setMode]);

    const effectiveMode = aiAvailable ? mode : ComposerInputMode.Sql;
    const assist = React.useMemo(
        () => effectiveMode === ComposerInputMode.Ai ? naturalLanguageAssist(identifierIndex) : undefined,
        [effectiveMode, identifierIndex],
    );
    return { mode: effectiveMode, assist, onTextChange, onEditorUpdate, pick, resolveSendMode };
}
