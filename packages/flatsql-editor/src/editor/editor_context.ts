import * as flatsql from '@ankoh/flatsql';
import { DecorationSet, Decoration } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

type StateChangedHandler = (state: EditorContext) => void;

/// The state of the FlatSQL editor plugin.
/// We pass this state container to the event callback so that it can be propagated as React state.
export class EditorContext {
    /// The API
    public readonly instance: flatsql.FlatSQL;
    /// The main script
    public readonly mainScript: flatsql.FlatSQLScript;
    /// The external script
    public readonly externalScript: flatsql.FlatSQLScript | null;
    /// The scanned script
    public scannedScript: flatsql.FlatBufferRef<flatsql.proto.ScannedScript> | null;
    /// The parsed script
    public parsedScript: flatsql.FlatBufferRef<flatsql.proto.ParsedScript> | null;
    /// The analyzed script
    public analyzedScript: flatsql.FlatBufferRef<flatsql.proto.AnalyzedScript> | null;
    /// The decorations
    public decorations: DecorationSet;
    /// The callback to subscribe for state updates
    public onStateChanged: StateChangedHandler | null;

    constructor(
        instance: flatsql.FlatSQL,
        main: flatsql.FlatSQLScript,
        external: flatsql.FlatSQLScript | null = null,
        onStateChanged: StateChangedHandler | null = null,
    ) {
        this.instance = instance;
        this.mainScript = main;
        this.externalScript = external;
        this.scannedScript = null;
        this.parsedScript = null;
        this.analyzedScript = null;
        this.onStateChanged = onStateChanged;
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

    public onScriptChanged(script: flatsql.FlatSQLScript) {
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

        // Build decorations
        this.updateDecorations();
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
