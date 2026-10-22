// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

class BaseNode {
    private _needsRun: boolean = true;
    private _inputs: Set<BaseNode> = new Set();
    private _targets: Set<BaseNode> = new Set();

    constructor(inputs: BaseNode[] = []) {
        this._inputs = new Set(inputs);
        for (let input of this._inputs) {
            input._targets.add(this);
        }
    }

    addInput(node: BaseNode) {
        this._inputs.add(node);
        node._targets.add(this);
    }

    removeInput(node: BaseNode) {
        node._targets.delete(this);
        this._inputs.delete(node);
    }

    run() {
        if (!this._needsRun) {
            return;
        }
        for (let input of this._inputs) {
            input.run();
        }
        this.update();
        this._needsRun = false;
    }

    setNeedsRunDownstream() {
        for (let t of this._targets) {
            if (!t._needsRun) {
                t._needsRun = true;
                t.setNeedsRunDownstream();
            }
        }
    }

    update() { }

    destroy() {
        for (let input of this._inputs) {
            input._targets.delete(this);
        }
    }
}

export class Node<T> extends BaseNode {
    private _value: T | null = null;

    protected setValue(newValue: T) {
        if (this._value !== newValue) {
            this._value = newValue;
            this.setNeedsRunDownstream();
        }
    }

    get value(): T {
        this.run();
        return this._value!;
    }
}

export class ValueNode<T> extends Node<T> {
    constructor(value: T) {
        super([]);
        this.setValue(value);
    }

    get value(): T {
        return super.value;
    }

    set value(newValue: T) {
        this.setValue(newValue);
    }
}

class ApplyNode<T> extends Node<T> {
    fn: () => T;

    constructor(fn: () => T, inputs: BaseNode[]) {
        super(inputs);
        this.fn = fn;
    }

    override update(): void {
        this.setValue(this.fn());
    }
}

class StatefulApplyNode<T, S extends State> extends Node<T> {
    fn: (input: Partial<S>) => T;
    state: Partial<S>;

    constructor(fn: (input: Partial<S>) => T, inputs: BaseNode[]) {
        super(inputs);
        this.fn = fn;
        this.state = {};
    }

    override update(): void {
        this.setValue(this.fn(this.state));
    }

    override destroy(): void {
        super.destroy();
        if (this.state.destroy) {
            this.state.destroy();
        }
        this.state = {};
    }
}

class IfNode<T1, T2> extends Node<T1 | T2> {
    parent: Dataflow;
    condition: Node<boolean>;
    buildTrue: (df: Dataflow) => Node<T1>;
    buildFalse: (df: Dataflow) => Node<T2>;

    context: Dataflow | null = null;
    currentCondition: boolean | null = null;
    currentNode: Node<T1> | Node<T2> | null = null;

    constructor(
        parent: Dataflow,
        condition: Node<boolean>,
        buildTrue: (df: Dataflow) => Node<T1>,
        buildFalse: (df: Dataflow) => Node<T2>,
    ) {
        super([condition]);
        this.parent = parent;
        this.condition = condition;
        this.buildTrue = buildTrue;
        this.buildFalse = buildFalse;
    }

    override update(): void {
        if (this.currentNode == null || this.currentCondition !== this.condition.value) {
            if (this.currentNode) {
                this.removeInput(this.currentNode);
            }
            this.context?.destroy();
            this.context = new Dataflow(this.parent);
            this.currentCondition = this.condition.value;
            if (this.currentCondition) {
                this.currentNode = this.buildTrue(this.context);
            } else {
                this.currentNode = this.buildFalse(this.context);
            }
            this.addInput(this.currentNode);
        }
        this.setValue(this.currentNode.value);
    }

    override destroy(): void {
        super.destroy();
        this.context?.destroy();
    }
}

class MapNode<T, U> extends Node<U[]> {
    parent: Dataflow;
    input: Node<T[]>;
    build: (df: Dataflow, arg: Node<T>) => Node<U>;
    cache: Map<T, { input: ValueNode<T>; output: Node<U>; context: Dataflow }>;

    constructor(parent: Dataflow, input: Node<T[]>, build: (df: Dataflow, arg: Node<T>) => Node<U>) {
        super([input]);
        this.parent = parent;
        this.input = input;
        this.build = build;
        this.cache = new Map();
    }

    override update(): void {
        let visited = new Set<T>();
        let mapped = this.input.value.map((t) => {
            visited.add(t);
            if (this.cache.has(t)) {
                let entry = this.cache.get(t)!;
                entry.input.value = t;
                return entry.output.value;
            } else {
                let context = new Dataflow(this.parent);
                let input = new ValueNode(t);
                let output = this.build(context, input);
                this.cache.set(t, { context, input, output });
                this.addInput(output);
                return output.value;
            }
        });
        for (let [key, entry] of this.cache) {
            if (!visited.has(key)) {
                this.cache.delete(key);
                this.removeInput(entry.output);
                entry.context.destroy();
            }
        }
        this.setValue(mapped);
    }

    override destroy(): void {
        super.destroy();
        for (let entry of this.cache.values()) {
            entry.context.destroy();
        }
    }
}

class SwitchNode<T> extends Node<T[keyof T]> {
    parent: Dataflow;
    input: Node<keyof T>;
    cases: { [K in keyof T]: (df: Dataflow) => Node<T[K]> };

    currentCase: keyof T | null = null;
    currentNode: Node<T[keyof T]> | null = null;
    currentContext: Dataflow | null = null;

    constructor(parent: Dataflow, input: Node<keyof T>, cases: { [K in keyof T]: (df: Dataflow) => Node<T[K]> }) {
        super([input]);
        this.parent = parent;
        this.input = input;
        this.cases = cases;
    }

    override update(): void {
        if (this.currentNode == null || this.input.value !== this.currentCase) {
            if (this.currentNode) {
                this.removeInput(this.currentNode);
            }
            this.currentContext?.destroy();
            this.currentContext = new Dataflow(this.parent);
            this.currentCase = this.input.value;
            this.currentNode = this.cases[this.currentCase](this.currentContext);
            this.addInput(this.currentNode);
        }
        this.setValue(this.currentNode.value);
    }

    override destroy(): void {
        super.destroy();
        this.currentContext?.destroy();
    }
}

export interface State {
    destroy?(): void;
}

type NodesOf<T extends any[]> = { [K in keyof T]: Node<T[K]> | T[K] };

export class Dataflow {
    private _children: Set<Dataflow>;
    private _nodes: Set<BaseNode>;

    /** Creates a new dataflow context. */
    constructor(parent: Dataflow | null = null) {
        this._children = new Set();
        this._nodes = new Set();
        parent?._children.add(this);
    }

    /** Destroy the dataflow and all associated states. */
    destroy(): void {
        for (let c of this._children) {
            c.destroy();
        }
        for (let n of this._nodes) {
            n.destroy();
        }
        this._children.clear();
        this._nodes.clear();
    }

    /** Creates a value node. */
    value<T>(value: T): ValueNode<T> {
        let r = new ValueNode(value);
        this._nodes.add(r);
        return r;
    }

    /** Creates a derived value. */
    derive<T extends any[], U>(args: NodesOf<T>, fn: (...arg: T) => U): Node<U> {
        let nodes: any = args.map((n) => (n instanceof BaseNode ? n : this.value(n)));
        let r = new ApplyNode(() => fn(...nodes.map((n: any) => n.value)), nodes);
        this._nodes.add(r);
        return r;
    }

    /** Creates a stateful derived value. */
    statefulDerive<T extends any[], U, S extends State>(
        args: NodesOf<T>,
        fn: (state: Partial<S>, ...arg: T) => U,
    ): Node<U> {
        let nodes: any = args.map((n) => (n instanceof BaseNode ? n : this.value(n)));
        let r = new StatefulApplyNode((s) => fn(s as any, ...nodes.map((n: any) => n.value)), nodes);
        this._nodes.add(r);
        return r;
    }

    /** Creates a true or false dataflow depending on the value of the condition. */
    if<T1, T2>(
        condition: Node<boolean>,
        buildTrue: (df: Dataflow) => Node<T1>,
        buildFalse: (df: Dataflow) => Node<T2>,
    ): Node<T1 | T2> {
        let r = new IfNode(this, condition, buildTrue, buildFalse);
        this._nodes.add(r);
        return r;
    }

    switch<T>(input: Node<keyof T>, cases: { [K in keyof T]: (df: Dataflow) => Node<T[K]> }): Node<T[keyof T]> {
        let r = new SwitchNode(this, input, cases);
        this._nodes.add(r);
        return r;
    }

    map<T, U>(input: Node<T[]>, build: (df: Dataflow, arg: Node<T>) => Node<U>): Node<U[]> {
        let r = new MapNode(this, input, build);
        this._nodes.add(r);
        return r;
    }

    assertNotNull<T>(node: Node<T | null | undefined>): Node<T> {
        return node as any;
    }

    subgraph(): Dataflow {
        return new Dataflow(this);
    }
}
