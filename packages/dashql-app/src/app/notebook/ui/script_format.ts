import * as dashql from '@ankoh/dashql-core';

import type { EditorView } from '@codemirror/view';

import type { ScriptData } from '../scripts/notebook_scripts.js';
import type { AppSettings } from '../../config/app_config.js';
import { ConnectorType } from '../connections/connector_info.js';

const DEFAULT_FORMAT_WIDTH = 80;
const DEFAULT_FORMAT_INDENTATION = 4;
const MIN_FORMAT_WIDTH = 24;

export function formattingDialectForConnector(connectorType?: ConnectorType): dashql.buffers.formatting.FormattingDialect {
    return connectorType === ConnectorType.TRINO
        ? dashql.buffers.formatting.FormattingDialect.TRINO
        : dashql.buffers.formatting.FormattingDialect.HYPER;
}

export function getKeywordCase(settings?: AppSettings): dashql.buffers.formatting.KeywordCase {
    return settings?.keywordCase === 'upper'
        ? dashql.buffers.formatting.KeywordCase.UPPER
        : dashql.buffers.formatting.KeywordCase.LOWER;
}

export function createScriptFormatConfig(
    mode: dashql.buffers.formatting.FormattingMode,
    debugMode: boolean = false,
    maxWidth: number = DEFAULT_FORMAT_WIDTH,
    keywordCase: dashql.buffers.formatting.KeywordCase = dashql.buffers.formatting.KeywordCase.LOWER,
    dialect: dashql.buffers.formatting.FormattingDialect = dashql.buffers.formatting.FormattingDialect.HYPER,
): dashql.buffers.formatting.FormattingConfigT {
    return new dashql.buffers.formatting.FormattingConfigT(
        dialect,
        mode,
        maxWidth,
        DEFAULT_FORMAT_INDENTATION,
        debugMode,
        keywordCase,
    );
}

export function measureScriptFormatWidth(editorView: Pick<EditorView, 'defaultCharacterWidth' | 'scrollDOM'>): number {
    const charWidth = editorView.defaultCharacterWidth;
    const availableWidth = editorView.scrollDOM.clientWidth;
    if (!(charWidth > 0) || !(availableWidth > 0)) {
        return DEFAULT_FORMAT_WIDTH;
    }
    return Math.max(MIN_FORMAT_WIDTH, Math.floor(availableWidth / charWidth));
}

export function isScriptFormattable(
    scriptData: ScriptData | null,
    dialect: dashql.buffers.formatting.FormattingDialect = dashql.buffers.formatting.FormattingDialect.HYPER,
): boolean {
    if (scriptData == null) return false;
    try {
        return scriptData.scriptSession.isFullyFormattable(
            createScriptFormatConfig(dashql.buffers.formatting.FormattingMode.PRETTY, false, DEFAULT_FORMAT_WIDTH,
                dashql.buffers.formatting.KeywordCase.LOWER, dialect),
            true,
        );
    } catch {
        return false;
    }
}

export function formatScriptEditor(
    editorView: EditorView | null,
    scriptData: ScriptData | null,
    mode: dashql.buffers.formatting.FormattingMode,
    onFormattedText: (text: string) => void,
    debugMode: boolean = false,
    keywordCase: dashql.buffers.formatting.KeywordCase = dashql.buffers.formatting.KeywordCase.LOWER,
    dialect: dashql.buffers.formatting.FormattingDialect = dashql.buffers.formatting.FormattingDialect.HYPER,
): boolean {
    if (editorView == null || scriptData == null) return false;

    let formattedScript: dashql.DashQLScript | null = null;
    try {
        const maxWidth = measureScriptFormatWidth(editorView);
        formattedScript = scriptData.scriptSession.format(
            createScriptFormatConfig(mode, debugMode, maxWidth, keywordCase, dialect),
            null,
        );
        const formattedText = formattedScript.toString();
        if (formattedText === editorView.state.doc.toString()) return false;
        onFormattedText(formattedText);
        editorView.focus();
        return true;
    } catch {
        return false;
    } finally {
        formattedScript?.destroy();
    }
}
