import * as flatsql from '@ankoh/flatsql';
import { EditorView, ViewUpdate, PluginValue, ViewPlugin, DecorationSet, Decoration } from '@codemirror/view';
import { RangeSetBuilder, Facet, Text as CMText } from '@codemirror/state';

/// A configuration for a FlatSQL editor plugin.
/// We use this configuration to inject the WebAssembly module.
export interface FlatSQLPluginConfig {
    /// The API
    instance: flatsql.FlatSQL;
    /// The main script
    mainScript: flatsql.FlatSQLScript;
    /// The external script
    externalScript: flatsql.FlatSQLScript | null;
}

/// A FlatSQL parser plugin that parses the CodeMirror text whenever it changes
class FlatSQLPluginValue implements PluginValue {
    /// The scanned script
    scannedScript: flatsql.FlatBufferRef<flatsql.proto.ScannedScript> | null;
    /// The parsed script
    parsedScript: flatsql.FlatBufferRef<flatsql.proto.ParsedScript> | null;
    /// The analyzed script
    analyzedScript: flatsql.FlatBufferRef<flatsql.proto.AnalyzedScript> | null;

    /// The decorations
    decorations: DecorationSet;

    /// Construct the plugin
    constructor(readonly view: EditorView) {
        this.scannedScript = null;
        this.parsedScript = null;
        this.analyzedScript = null;

        // Build decorations
        let builder = new RangeSetBuilder<Decoration>();
        this.decorations = builder.finish();

        // Resolve the parser
        const config = this.view.state.facet(FlatSQLPlugin)!;
        if (!config.instance) {
            console.error('FlatSQL module not set');
            return;
        }
        // Replace main script content with script text
        const text = view.state.doc.toString();
        config.mainScript.eraseTextRange(0, Number.MAX_SAFE_INTEGER);
        config.mainScript.insertTextAt(0, text);
        // Update the script
        this.onDocChanged(config.mainScript);
    }

    /// Destroy the plugin
    destroy() {
        if (this.scannedScript != null) {
            this.scannedScript.delete();
            this.scannedScript = null;
        }
        if (this.parsedScript != null) {
            this.parsedScript.delete();
            this.parsedScript = null;
        }
        if (this.analyzedScript != null) {
            this.analyzedScript.delete();
            this.analyzedScript = null;
        }
    }

    /// Did the doc change?
    protected onDocChanged(script: flatsql.FlatSQLScript) {
        // Scan the script
        console.time('Script Scanning');
        if (this.scannedScript != null) {
            this.scannedScript.delete();
            this.scannedScript = null;
        }
        this.scannedScript = script.scan();
        console.timeEnd('Script Scanning');

        // Parse the script
        console.time('Script Parsing');
        if (this.parsedScript != null) {
            this.parsedScript.delete();
            this.parsedScript = null;
        }
        this.parsedScript = script.parse();
        console.timeEnd('Script Parsing');

        // Parse the script
        console.time('Script Analyzing');
        if (this.analyzedScript != null) {
            this.analyzedScript.delete();
            this.analyzedScript = null;
        }
        this.analyzedScript = script.analyze();
        console.timeEnd('Script Analyzing');
    }

    /// Apply a view update
    update(update: ViewUpdate) {
        // The the extension props
        const config = this.view.state.facet(FlatSQLPlugin)!;
        if (!config.instance) {
            console.warn('FlatSQL module not set');
            return;
        }
        // Did the doc change?
        if (update.docChanged) {
            // Apply the text changes
            console.time('Rope Insert');
            update.changes.iterChanges((fromA: number, toA: number, fromB: number, toB: number, inserted: CMText) => {
                if (toA - fromA > 0) {
                    config.mainScript.eraseTextRange(fromA, toA - fromA);
                }
                if (inserted.length > 0) {
                    let writer = fromB;
                    for (const text of inserted.iter()) {
                        config.mainScript.insertTextAt(writer, text);
                        writer += text.length;
                    }
                }
            });
            console.timeEnd('Rope Insert');

            // Update the document
            this.onDocChanged(config.mainScript);
            return;
        }
    }
}

/// A facet to setup the CodeMirror extensions.
/// Example:
///   const config = new FlatSQLExtensionConfig(parser);
///   return (<CodeMirror extensions={[ FlatSQLExtension.of(config) ]} />);
export const FlatSQLPlugin = Facet.define<FlatSQLPluginConfig, FlatSQLPluginConfig | null>({
    // Just use the first config
    combine(configs) {
        return configs.length ? configs[0] : null;
    },
    // Enable the extension
    enables: _ => [
        ViewPlugin.fromClass(FlatSQLPluginValue, {
            decorations: v => v.decorations,
        }),
    ],
});
