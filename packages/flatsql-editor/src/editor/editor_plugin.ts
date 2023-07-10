import { EditorView, ViewUpdate, PluginValue, ViewPlugin, Decoration } from '@codemirror/view';
import { RangeSet, Facet, Text as CMText } from '@codemirror/state';
import { FlatSQLState, EditorContextAction, UPDATE_MAIN_SCRIPT } from '../flatsql_state';
import { Dispatch } from '../model/action';

import './editor_plugin.css';

export interface EditorPluginProps {
    context: FlatSQLState;
    dispatchContext: Dispatch<EditorContextAction>;
}

/// A FlatSQL parser plugin that parses the CodeMirror text whenever it changes
class EditorPluginValue implements PluginValue {
    /// Construct the plugin
    constructor(readonly view: EditorView) {}

    getDecorations(): RangeSet<Decoration> {
        const deco = this.view.state.facet(EditorPlugin)!.context.mainDecorations;
        return deco;
    }

    /// Destroy the plugin
    destroy() {}
    /// Apply a view update
    update(update: ViewUpdate) {
        // The the extension props
        const state = this.view.state.facet(EditorPlugin)!;
        // Script is missing? Nothing to do then
        if (!state.context.mainScript) {
            return;
        }
        const mainScript = state.context.mainScript;
        // Did the doc change?
        if (update.docChanged) {
            // Apply the text changes
            console.time('Rope Insert');
            update.changes.iterChanges((fromA: number, toA: number, fromB: number, toB: number, inserted: CMText) => {
                if (toA - fromA > 0) {
                    mainScript.eraseTextRange(fromA, toA - fromA);
                }
                if (inserted.length > 0) {
                    let writer = fromB;
                    for (const text of inserted.iter()) {
                        mainScript.insertTextAt(writer, text);
                        writer += text.length;
                    }
                }
            });
            console.timeEnd('Rope Insert');

            // Update the document
            state.dispatchContext({
                type: UPDATE_MAIN_SCRIPT,
                value: undefined,
            });
            return;
        }
    }
}

/// A facet to setup the CodeMirror extensions.
/// Example:
///   const config = new FlatSQLExtensionConfig(parser);
///   return (<CodeMirror extensions={[ FlatSQLExtension.of(config) ]} />);
export const EditorPlugin = Facet.define<EditorPluginProps, EditorPluginProps | null>({
    // Just use the first config
    combine(configs) {
        return configs.length ? configs[0] : null;
    },
    // Enable the extension
    enables: _ => [
        ViewPlugin.fromClass(EditorPluginValue, {
            decorations: v => v.getDecorations(),
        }),
    ],
});
