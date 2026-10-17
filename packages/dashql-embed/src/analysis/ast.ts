import { buffers } from '@ankoh/dashql-core';

const NodeType = buffers.parser.NodeType;
const AttributeKey = buffers.parser.AttributeKey;

const decoder = new TextDecoder();

/// A flattened, read-only view of the DashQL AST with helpers to resolve node text.
/// The node table is copied out of the flatbuffer once since feature extraction visits every node repeatedly.
export class Ast {
    readonly bytes: Uint8Array;
    readonly nodeTypes: Uint8Array;
    readonly attributeKeys: Uint16Array;
    readonly parents: Uint32Array;
    readonly childrenBeginOrValue: Uint32Array;
    readonly childrenCount: Uint32Array;
    readonly spanOffsets: Uint32Array;
    readonly spanLengths: Uint32Array;
    readonly tokenOffsets: Uint32Array;
    readonly tokenLengths: Uint32Array;
    readonly tokenTypes: Uint8Array;

    constructor(parsed: buffers.parser.ParsedScript, bytes: Uint8Array) {
        this.bytes = bytes;
        const n = parsed.nodesLength();
        this.nodeTypes = new Uint8Array(n);
        this.attributeKeys = new Uint16Array(n);
        this.parents = new Uint32Array(n);
        this.childrenBeginOrValue = new Uint32Array(n);
        this.childrenCount = new Uint32Array(n);
        this.spanOffsets = new Uint32Array(n);
        this.spanLengths = new Uint32Array(n);
        const node = new buffers.parser.Node();
        const span = new buffers.parser.SymbolSpan();
        for (let i = 0; i < n; ++i) {
            parsed.nodes(i, node);
            this.nodeTypes[i] = node.nodeType();
            this.attributeKeys[i] = node.attributeKey();
            this.parents[i] = node.parent();
            this.childrenBeginOrValue[i] = node.childrenBeginOrValue();
            this.childrenCount[i] = node.childrenCount();
            const s = node.symbolSpan(span);
            this.spanOffsets[i] = s?.offset() ?? 0;
            this.spanLengths[i] = s?.length() ?? 0;
        }
        const tokens = parsed.tokens();
        this.tokenOffsets = tokens?.tokenOffsetsArray() ?? new Uint32Array();
        this.tokenLengths = tokens?.tokenLengthsArray() ?? new Uint32Array();
        this.tokenTypes = tokens?.tokenTypesArray() ?? new Uint8Array();
    }

    get length(): number {
        return this.nodeTypes.length;
    }

    type(node: number): buffers.parser.NodeType {
        return this.nodeTypes[node];
    }

    key(node: number): buffers.parser.AttributeKey {
        return this.attributeKeys[node];
    }

    hasChildren(node: number): boolean {
        const t = this.nodeTypes[node];
        if (t >= NodeType.ENUM_VIS_ENCODING_CHANNEL && t <= NodeType.VIS_OBJECT_KEYS_) {
            return false;
        }
        return t === NodeType.ARRAY || t > NodeType.OBJECT_KEYS_;
    }

    /// The value of enum, bool or name nodes
    value(node: number): number {
        return this.childrenBeginOrValue[node];
    }

    children(node: number): number[] {
        if (!this.hasChildren(node)) {
            return [];
        }
        const begin = this.childrenBeginOrValue[node];
        const out = new Array<number>(this.childrenCount[node]);
        for (let i = 0; i < out.length; ++i) {
            out[i] = begin + i;
        }
        return out;
    }

    /// Find the child with a given attribute key
    child(node: number, key: buffers.parser.AttributeKey): number | null {
        if (!this.hasChildren(node)) {
            return null;
        }
        const begin = this.childrenBeginOrValue[node];
        const end = begin + this.childrenCount[node];
        for (let i = begin; i < end; ++i) {
            if (this.attributeKeys[i] === key) {
                return i;
            }
        }
        return null;
    }

    /// Get the parent of a node, null for statement roots
    parent(node: number): number | null {
        const p = this.parents[node];
        return p === node || p >= this.length ? null : p;
    }

    /// The UTF-8 byte range covered by a node
    byteRange(node: number): [number, number] {
        const length = this.spanLengths[node];
        if (length === 0) {
            return [0, 0];
        }
        const first = this.spanOffsets[node];
        const last = first + length - 1;
        return [this.tokenOffsets[first], this.tokenOffsets[last] + this.tokenLengths[last]];
    }

    text(node: number): string {
        const [begin, end] = this.byteRange(node);
        return decoder.decode(this.bytes.subarray(begin, end));
    }

    tokenText(token: number): string {
        const begin = this.tokenOffsets[token];
        return decoder.decode(this.bytes.subarray(begin, begin + this.tokenLengths[token]));
    }

    /// Visit all nodes of a subtree in pre-order
    walk(root: number, visit: (node: number) => boolean | void): void {
        const pending = [root];
        while (pending.length > 0) {
            const node = pending.pop()!;
            if (visit(node) === false) {
                continue;
            }
            const children = this.children(node);
            for (let i = children.length - 1; i >= 0; --i) {
                pending.push(children[i]);
            }
        }
    }

    /// Render a (possibly qualified) name node or name array as dotted text without quotes
    nameText(node: number): string {
        if (this.type(node) === NodeType.ARRAY) {
            return this.children(node)
                .map(c => this.nameText(c))
                .filter(s => s.length > 0)
                .join('.');
        }
        return unquoteIdentifier(this.text(node));
    }
}

export function unquoteIdentifier(text: string): string {
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
        return text.slice(1, -1).replace(/""/g, '"');
    }
    return text.toLowerCase();
}

export { NodeType, AttributeKey };
