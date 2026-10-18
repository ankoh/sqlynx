import * as buffers from './buffers.js';

/// The tag that opens a properties block
export const PROPERTIES_TAG = '@dashql:properties';
/// The tag that closes a tagged region of line comments
export const COMMENT_TAG_END = '@dashql:end';

/// User-provided properties of a script, the JSON object of its `@dashql:properties` block
export type ScriptProperties = Record<string, unknown>;

const NO_BLOCK = 0xffffffff;
const decoder = new TextDecoder();

/// Read the properties of a parsed script.
/// `bytes` is the UTF-8 encoded script text, the parser validated that the block holds a JSON object.
/// Returns null if the script has no valid properties block.
export function readProperties(parsed: buffers.parser.ParsedScript, bytes: Uint8Array): ScriptProperties | null {
    const blockId = parsed.propertiesBlock();
    if (blockId === NO_BLOCK || blockId >= parsed.commentBlocksLength()) {
        return null;
    }
    const block = parsed.commentBlocks(blockId)!;
    const line = new buffers.parser.TextSpan();
    const lines: string[] = [];
    for (let i = 0; i < block.linesCount(); ++i) {
        parsed.commentLines(block.linesBegin() + i, line);
        lines.push(decoder.decode(bytes.subarray(line.offset(), line.offset() + line.length())));
    }
    try {
        return JSON.parse(lines.join('\n')) as ScriptProperties;
    } catch {
        return null;
    }
}

/// Render a properties block as line comments, without a trailing line break.
/// The properties are pretty-printed JSON. JSON strings never contain raw line breaks, so no value can close the
/// block early. The line form is used since a `*/` within a string would end a block comment.
export function renderPropertiesBlock(properties: ScriptProperties, eol = '\n'): string {
    const json = JSON.stringify(properties, null, 2);
    const lines = [PROPERTIES_TAG, ...json.split('\n'), COMMENT_TAG_END];
    return lines.map(l => `-- ${l}`).join(eol);
}
