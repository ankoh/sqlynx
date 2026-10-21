import { EditorView } from '@codemirror/view';

import { DashQLDecorationPlugin } from './dashql_decorations.js';
import { DashQLProcessorPlugin, DashQLCompletionStartEffect } from './dashql_processor.js';
import { DashQLCursorDiagnosticsPlugin } from './dashql_cursor_diagnostics.js';
import { DashQLGutterPlugin } from './dashql_gutters.js';
import { DashQLCompletionHintPlugin } from './dashql_completion_hint.js';
import { DashQLCompletionListPlugin } from './dashql_completion_list.js';
import { DashQLCompletionListenerPlugin } from './dashql_completion_listener.js';
import { DashQLDiffDecorationPlugin } from './dashql_diff_decorations.js';
import { DashQLDiffHintPlugin } from './dashql_diff_hint.js';
import { DashQLAutoclosePlugin } from './dashql_autoclose.js';
import { DashQLQuoteTombstonePlugin } from './dashql_quote_tombstone.js';

/// Starts a completion when an empty editor gains focus
export const DashQLFocusCompletionEffect = EditorView.focusChangeEffect.of((state, focusing) => {
    if (!focusing || state.doc.length > 0) return null;
    return DashQLCompletionStartEffect.of(null);
});

export const DashQLExtensions = [
    DashQLProcessorPlugin,
    DashQLQuoteTombstonePlugin,
    DashQLAutoclosePlugin,
    DashQLFocusCompletionEffect,
    DashQLCompletionHintPlugin,
    DashQLCompletionListPlugin,
    DashQLCompletionListenerPlugin,
    DashQLDiffDecorationPlugin,
    DashQLDiffHintPlugin,
    DashQLDecorationPlugin,
    DashQLCursorDiagnosticsPlugin,
    DashQLGutterPlugin,
];

export const DashQLReadonlyExtensions = [
    DashQLProcessorPlugin,
    DashQLDecorationPlugin,
    DashQLCursorDiagnosticsPlugin,
    DashQLGutterPlugin,
];
