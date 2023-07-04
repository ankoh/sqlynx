import { EditorView, ViewUpdate, PluginValue, ViewPlugin, Decoration } from '@codemirror/view';
import { RangeSet, Facet, Text as CMText } from '@codemirror/state';
import { FlatSQLEditorContext } from './editor_context';

import './editor_plugin.css';

/// A FlatSQL parser plugin that parses the CodeMirror text whenever it changes
class FlatSQLEditorPlugin implements PluginValue {
    /// Construct the plugin
    constructor(readonly view: EditorView) {
        // Resolve the parser
        const state = this.view.state.facet(FlatSQLEditor)!;
        if (!state.instance) {
            throw new Error('FlatSQL module not set');
        }
        // Replace main script content with script text
        const text = view.state.doc.toString();
        state.mainScript.eraseTextRange(0, Number.MAX_SAFE_INTEGER);
        state.mainScript.insertTextAt(0, text);
        // Update the script
        state.onScriptChanged(state.mainScript);
        // Notify users about state change
        if (state.onStateChanged) {
            state.onStateChanged(state);
        }
    }

    getDecorations(): RangeSet<Decoration> {
        return this.view.state.facet(FlatSQLEditor)!.decorations;
    }

    /// Destroy the plugin
    destroy() {
        const state = this.view.state.facet(FlatSQLEditor)!;
        state?.destroy();
    }

    /// Apply a view update
    update(update: ViewUpdate) {
        // The the extension props
        const state = this.view.state.facet(FlatSQLEditor)!;
        if (!state.instance) {
            console.warn('FlatSQL module not set');
            return;
        }
        // Did the doc change?
        if (update.docChanged) {
            // Apply the text changes
            console.time('Rope Insert');
            update.changes.iterChanges((fromA: number, toA: number, fromB: number, toB: number, inserted: CMText) => {
                if (toA - fromA > 0) {
                    state.mainScript.eraseTextRange(fromA, toA - fromA);
                }
                if (inserted.length > 0) {
                    let writer = fromB;
                    for (const text of inserted.iter()) {
                        state.mainScript.insertTextAt(writer, text);
                        writer += text.length;
                    }
                }
            });
            console.timeEnd('Rope Insert');

            // Update the document
            state.onScriptChanged(state.mainScript);
            // Notify users about state change
            if (state.onStateChanged) {
                state.onStateChanged(state);
            }
            return;
        }
    }
}

/// A facet to setup the CodeMirror extensions.
/// Example:
///   const config = new FlatSQLExtensionConfig(parser);
///   return (<CodeMirror extensions={[ FlatSQLExtension.of(config) ]} />);
export const FlatSQLEditor = Facet.define<FlatSQLEditorContext, FlatSQLEditorContext | null>({
    // Just use the first config
    combine(configs) {
        return configs.length ? configs[0] : null;
    },
    // Enable the extension
    enables: _ => [
        ViewPlugin.fromClass(FlatSQLEditorPlugin, {
            decorations: v => v.getDecorations(),
        }),
    ],
});
