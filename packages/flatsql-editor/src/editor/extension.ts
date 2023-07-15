import { EditorView, Decoration, DecorationSet, PluginValue, ViewPlugin, ViewUpdate } from '@codemirror/view';
import {
    StateField,
    StateEffect,
    StateEffectType,
    Facet,
    Text,
    Transaction,
    RangeSetBuilder,
    ChangeSpec,
    Annotation,
    RangeSet,
} from '@codemirror/state';
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
                    if (transaction.changes.length == 0) {
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
                    console.log('SCRIPT CHANGE');
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

export const FlatSQLExtension = [FlatSQLScriptUpdater, FlatSQLDecorationUpdater];

// /// A FlatSQL parser plugin that parses the CodeMirror text whenever it changes
// class EditorPluginValue implements PluginValue {
//     /// Construct the plugin
//     constructor(readonly view: EditorView) {}
//
//     getDecorations(): RangeSet<Decoration> {
//         const deco = this.view.state.facet(EditorPlugin)!.context.mainDecorations;
//         return deco;
//     }
//
//     /// Destroy the plugin
//     destroy() {}
//     /// Apply a view update
//     update(update: ViewUpdate) {
//
//     }
// }
//
// /// A facet to setup the CodeMirror extensions.
// /// Example:
// ///   const config = new FlatSQLExtensionConfig(parser);
// ///   return (<CodeMirror extensions={[ FlatSQLExtension.of(config) ]} />);
// export const EditorPlugin = Facet.define<EditorPluginProps, EditorPluginProps | null>({
//     // Just use the first config
//     combine(configs) {
//         return configs.length ? configs[0] : null;
//     },
//     // Enable the extension
//     enables: _ => [
//         ViewPlugin.fromClass(EditorPluginValue, {
//             decorations: v => v.getDecorations(),
//         }),
//     ],
// });
