import {
    EditorView,
    Decoration,
    DecorationSet,
    PluginValue,
    ViewPlugin,
    ViewUpdate,
    lineNumbers,
} from '@codemirror/view';
import { StateField, StateEffect, StateEffectType, Text, Transaction, RangeSetBuilder } from '@codemirror/state';
import * as flatsql from '@ankoh/flatsql';

import './extension.css';

export interface FlatSQLScriptUpdate {
    // The currently active script
    script: flatsql.FlatSQLScript | null;
    // This callback is called when the editor modifies the script.
    // We could later think of specifying what exactly changed, but right now, we just don't care and update everything.
    onChange: (script: flatsql.FlatSQLScript) => void;
}
/// Effect to update a FlatSQL script attached to a CodeMirror editor
export const UpdateFlatSQLScript: StateEffectType<FlatSQLScriptUpdate> = StateEffect.define<FlatSQLScriptUpdate>();
/// An updater that mirrors CodeMirror editor changes to a FlatSQL script
const FlatSQLScriptUpdater: StateField<FlatSQLScriptUpdate> = StateField.define<FlatSQLScriptUpdate>({
    // Create the initial state
    create: () => {
        // By default, the FlatSQL script is not configured
        const config: FlatSQLScriptUpdate = {
            script: null,
            onChange: (script: flatsql.FlatSQLScript) => {},
        };
        return config;
    },
    // Mirror the FlatSQL state
    update: (current: FlatSQLScriptUpdate, transaction: Transaction) => {
        // Check if the user reconfigured the plugin (potentially replacing the script)
        let config = current;
        for (const effect of transaction.effects) {
            // Reconfigure the FlatSQL state?
            if (effect.is(UpdateFlatSQLScript)) {
                // Did the active script change?
                // Bail out of applying updates since the transaction first has to switch to the new script.
                if (current.script !== effect.value.script) {
                    // Warn the user if he forgot to also change the script text
                    if (transaction.changes.empty) {
                        console.warn('FlatSQL script was updated without changing the document');
                    }
                    return effect.value;
                }
                // Script stayed the same, onChange callback might have changed.
                // Apply any text changes regularly.
                config = effect.value;
            }
        }
        // Apply all changes if the current script, if script is != null.
        if (config.script != null && transaction.docChanged) {
            transaction.changes.iterChanges(
                (fromA: number, toA: number, fromB: number, toB: number, inserted: Text) => {
                    if (toA - fromA > 0) {
                        current.script!.eraseTextRange(fromA, toA - fromA);
                    }
                    if (inserted.length > 0) {
                        let writer = fromB;
                        for (const text of inserted.iter()) {
                            current.script!.insertTextAt(writer, text);
                            writer += text.length;
                        }
                    }
                },
            );

            // Notify the user about the updated script
            current.onChange(config.script);
        }
        return current;
    },
});

/// Effect to update a FlatSQL decorations in CodeMirror editor
export const UpdateFlatSQLDecorations: StateEffectType<DecorationSet> = StateEffect.define<DecorationSet>();
/// An updater that provides FlatSQL decorations to CodeMirror
const FlatSQLDecorationUpdater: StateField<DecorationSet> = StateField.define<DecorationSet>({
    // Create the initial state
    create: () => {
        return new RangeSetBuilder<Decoration>().finish();
    },
    // Update the decorations
    update: (current: DecorationSet, transaction: Transaction) => {
        for (const effect of transaction.effects) {
            if (effect.is(UpdateFlatSQLDecorations)) {
                return effect.value;
            }
        }
        return current;
    },
    // Use this field for decorations
    provide: (field: StateField<DecorationSet>) => EditorView.decorations.from(field),
});

export const FlatSQLExtensions = [lineNumbers(), FlatSQLScriptUpdater, FlatSQLDecorationUpdater];
