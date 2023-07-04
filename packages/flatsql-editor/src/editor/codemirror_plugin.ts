import * as flatsql from '@ankoh/flatsql';
import { EditorView, ViewUpdate, PluginValue, ViewPlugin, DecorationSet, Decoration } from '@codemirror/view';
import { RangeSetBuilder, Facet, Text as CMText } from '@codemirror/state';

import './codemirror_plugin.css';

/// A configuration for a FlatSQL editor plugin.
export interface FlatSQLEditorConfig {
    /// The API
    instance: flatsql.FlatSQL;
    /// The main script
    mainScript: flatsql.FlatSQLScript;
    /// The external script
    externalScript: flatsql.FlatSQLScript | null;
    /// The callback to subscribe for state updates
    onStateChanged: (state: FlatSQLEditorState) => void;
}

/// The state of the FlatSQL editor plugin.
/// We pass this state container to the event callback so that it can be propagated as React state.
export class FlatSQLEditorState {
    /// The scanned script
    public scannedScript: flatsql.FlatBufferRef<flatsql.proto.ScannedScript> | null;
    /// The parsed script
    public parsedScript: flatsql.FlatBufferRef<flatsql.proto.ParsedScript> | null;
    /// The analyzed script
    public analyzedScript: flatsql.FlatBufferRef<flatsql.proto.AnalyzedScript> | null;
    /// The decorations
    public decorations: DecorationSet;

    constructor() {
        this.scannedScript = null;
        this.parsedScript = null;
        this.analyzedScript = null;
        this.decorations = new RangeSetBuilder<Decoration>().finish();
    }

    public destroy() {
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

    /// Update the CodeMirror decorations
    public updateDecorations() {
        if (!this.scannedScript) {
            return;
        }
        // Build decorations
        let builder = new RangeSetBuilder<Decoration>();
        const scan = this.scannedScript.read(new flatsql.proto.ScannedScript());
        const hl = scan.highlighting();
        if (hl) {
            const tokenOffsets = hl.tokenOffsetsArray()!;
            const tokenTypes = hl.tokenTypesArray()!;
            let prevOffset = 0;
            let prevType = Token.NONE;
            for (let i = 0; i < tokenOffsets.length; ++i) {
                const begin = prevOffset;
                const end = tokenOffsets[i];
                switch (prevType) {
                    case Token.KEYWORD:
                        builder.add(begin, end, keywordDecoration);
                        break;
                    default:
                        break;
                }
                prevOffset = end;
                prevType = tokenTypes[i];
            }
        }
        this.decorations = builder.finish();
    }
}

const Token = flatsql.proto.HighlightingTokenType;

const keywordDecoration = Decoration.mark({
    class: 'flatsql-keyword',
});

/// A FlatSQL parser plugin that parses the CodeMirror text whenever it changes
class FlatSQLEditorValue implements PluginValue {
    /// The plugin state
    state: FlatSQLEditorState;

    /// Construct the plugin
    constructor(readonly view: EditorView) {
        // Resolve the parser
        const config = this.view.state.facet(FlatSQLEditor)!;
        if (!config.instance) {
            throw new Error('FlatSQL module not set');
        }
        // Create the state container
        this.state = new FlatSQLEditorState();
        // Replace main script content with script text
        const text = view.state.doc.toString();
        config.mainScript.eraseTextRange(0, Number.MAX_SAFE_INTEGER);
        config.mainScript.insertTextAt(0, text);
        // Update the script
        this.onDocChanged(config.mainScript);
    }

    /// Destroy the plugin
    destroy() {
        this.state.destroy();
    }

    /// Did the doc change?
    protected onDocChanged(script: flatsql.FlatSQLScript) {
        // Scan the script
        // console.time('Script Scanning');
        if (this.state.scannedScript != null) {
            this.state.scannedScript.delete();
            this.state.scannedScript = null;
        }
        this.state.scannedScript = script.scan();
        // console.timeEnd('Script Scanning');

        // Parse the script
        // console.time('Script Parsing');
        if (this.state.parsedScript != null) {
            this.state.parsedScript.delete();
            this.state.parsedScript = null;
        }
        this.state.parsedScript = script.parse();
        // console.timeEnd('Script Parsing');

        // Parse the script
        // console.time('Script Analyzing');
        if (this.state.analyzedScript != null) {
            this.state.analyzedScript.delete();
            this.state.analyzedScript = null;
        }
        this.state.analyzedScript = script.analyze();
        // console.timeEnd('Script Analyzing');

        // Build decorations
        this.state.updateDecorations();
    }

    /// Apply a view update
    update(update: ViewUpdate) {
        // The the extension props
        const config = this.view.state.facet(FlatSQLEditor)!;
        if (!config.instance) {
            console.warn('FlatSQL module not set');
            return;
        }
        // Did the doc change?
        if (update.docChanged) {
            // Apply the text changes
            // console.time('Rope Insert');
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
            // console.timeEnd('Rope Insert');

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
export const FlatSQLEditor = Facet.define<FlatSQLEditorConfig, FlatSQLEditorConfig | null>({
    // Just use the first config
    combine(configs) {
        return configs.length ? configs[0] : null;
    },
    // Enable the extension
    enables: _ => [
        ViewPlugin.fromClass(FlatSQLEditorValue, {
            decorations: v => v.state.decorations,
        }),
    ],
});
