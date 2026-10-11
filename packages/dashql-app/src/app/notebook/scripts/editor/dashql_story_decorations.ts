import * as core from '@ankoh/dashql-core';

import { Decoration, DecorationSet, EditorView, GutterMarker, gutter, lineNumbers, WidgetType } from '@codemirror/view';
import { EditorState, type Extension, Range, RangeSet, RangeSetBuilder, StateEffect, StateEffectType, StateField, Transaction } from '@codemirror/state';

interface StoryStatement {
    id: number;
    from: number;
    to: number;
    label: string;
}

interface StoryModel {
    statements: StoryStatement[];
}

export type StoryActivation = 'toggle' | 'open';

interface StoryConfig {
    activation: StoryActivation;
    onActivate?: (statementId: number) => void;
    showGutter?: boolean;
}

export interface StoryState {
    model: StoryModel | null;
    expanded: ReadonlySet<number>;
    decorations: DecorationSet;
    atomicRanges: DecorationSet;
    gutterMarkers: RangeSet<GutterMarker>;
}

export const DashQLStoryUpdateEffect: StateEffectType<core.buffers.editor.EditorUpdateT | null> =
    StateEffect.define<core.buffers.editor.EditorUpdateT | null>();
export const DashQLStoryToggleStatementEffect: StateEffectType<number> = StateEffect.define<number>();

/// Return whether any statement has description comments. This lets the preview preserve its compact
/// rendering for ordinary SQL while using raw source offsets only when descriptions are present.
export function hasStatementDescriptions(update: core.buffers.editor.EditorUpdateT | null | undefined): boolean {
    return (update?.scriptAnnotations?.statementDescriptions.length ?? 0) > 0;
}

function statementLabel(type: core.buffers.parser.StatementType): string {
    switch (type) {
        case core.buffers.parser.StatementType.CREATE_TABLE:
        case core.buffers.parser.StatementType.CREATE_TABLE_AS:
            return 'create table';
        case core.buffers.parser.StatementType.CREATE_VIEW:
            return 'create view';
        case core.buffers.parser.StatementType.SELECT:
            return 'select';
        case core.buffers.parser.StatementType.SET:
            return 'set';
        case core.buffers.parser.StatementType.VIS_VISUALISE:
            return 'visualize';
        case core.buffers.parser.StatementType.CREATE_FUNCTION:
            return 'create function';
        case core.buffers.parser.StatementType.EXPLAIN:
            return 'explain';
        case core.buffers.parser.StatementType.DROP_TABLE:
            return 'drop table';
        case core.buffers.parser.StatementType.DROP_VIEW:
            return 'drop view';
        case core.buffers.parser.StatementType.SELECT_INTO:
            return 'select into';
        case core.buffers.parser.StatementType.ATTACH_DATABASE:
            return 'attach database';
        case core.buffers.parser.StatementType.INSERT:
            return 'insert into';
        default:
            return 'statement';
    }
}

function buildStoryModel(update: core.buffers.editor.EditorUpdateT | null, activation: StoryActivation): StoryModel | null {
    if (update == null || update.diagnostics.some(d => d.source !== core.buffers.editor.EditorDiagnosticSource.ANALYZER)) {
        return null;
    }
    const statements: StoryStatement[] = [];
    const annotations = update.scriptAnnotations;
    const source = activation === 'toggle' ? annotations?.statements : annotations?.statementDescriptions;
    for (const current of source ?? []) {
        const span = current.textSpan;
        if (span == null) continue;
        const from = Number(span.offset);
        const to = Number(span.offset + span.length);
        if (from >= to) return null;
        statements.push({
            id: current.statementId,
            from,
            to,
            label: statementLabel(current.statementType),
        });
    }
    return statements.length > 0 ? { statements } : null;
}

class ExpandStatementControl extends WidgetType {
    constructor(
        private readonly statementId: number,
        private readonly label: string,
        private readonly activation: StoryActivation,
        private readonly onActivate: ((statementId: number) => void) | undefined,
    ) { super(); }

    eq(other: ExpandStatementControl) {
        return this.statementId === other.statementId && this.label === other.label && this.activation === other.activation;
    }

    toDOM(view: EditorView): HTMLElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dashql-story-sql-control';
        button.dataset.dashqlStoryControl = 'true';
        button.dataset.dashqlStoryStatement = String(this.statementId);
        button.setAttribute('aria-expanded', 'false');
        button.textContent = this.label;
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (this.activation === 'open') {
                this.onActivate?.(this.statementId);
                return;
            }
            view.dispatch({ effects: DashQLStoryToggleStatementEffect.of(this.statementId) });
            requestAnimationFrame(() => {
                view.dom.querySelector<HTMLButtonElement>(`[data-dashql-story-statement="${this.statementId}"]`)?.focus();
            });
        });
        return button;
    }

    ignoreEvent() { return false; }
}

class StoryFoldMarker extends GutterMarker {
    constructor(
        private readonly statementId: number,
        private readonly expanded: boolean,
    ) { super(); }

    eq(other: StoryFoldMarker) { return this.statementId === other.statementId && this.expanded === other.expanded; }

    toDOM(view: EditorView): HTMLElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dashql-story-fold-control';
        button.dataset.dashqlStoryControl = 'true';
        button.dataset.dashqlStoryStatement = String(this.statementId);
        button.setAttribute('aria-expanded', String(this.expanded));
        button.setAttribute('aria-label', this.expanded ? 'Collapse SQL statement' : 'Expand SQL statement');
        button.textContent = this.expanded ? '▾' : '▸';
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            view.dispatch({ effects: DashQLStoryToggleStatementEffect.of(this.statementId) });
            requestAnimationFrame(() => {
                view.dom.querySelector<HTMLButtonElement>(`[data-dashql-story-statement="${this.statementId}"]`)?.focus();
            });
        });
        return button;
    }

    ignoreEvent() { return false; }
}

class StoryFoldSpacer extends GutterMarker {
    toDOM(): HTMLElement {
        const spacer = document.createElement('span');
        spacer.className = 'dashql-story-fold-spacer';
        return spacer;
    }
}

function buildDecorations(state: EditorState, model: StoryModel | null, expanded: ReadonlySet<number>, config: StoryConfig): Pick<StoryState, 'decorations' | 'atomicRanges' | 'gutterMarkers'> {
    if (model == null) return { decorations: Decoration.none, atomicRanges: Decoration.none, gutterMarkers: RangeSet.empty };
    const ranges: Range<Decoration>[] = [];
    const atomic: Range<Decoration>[] = [];
    const gutterBuilder = new RangeSetBuilder<GutterMarker>();
    for (const statement of model.statements) {
        const isExpanded = expanded.has(statement.id);
        if (config.activation === 'open' || !isExpanded) {
            const replacement = Decoration.replace({
                widget: new ExpandStatementControl(statement.id, statement.label, config.activation, config.onActivate),
                inclusive: false,
            });
            ranges.push(replacement.range(statement.from, statement.to));
            atomic.push(replacement.range(statement.from, statement.to));
        }
        if (config.activation === 'toggle') gutterBuilder.add(statement.from, statement.from, new StoryFoldMarker(statement.id, isExpanded));
    }
    return { decorations: Decoration.set(ranges, true), atomicRanges: Decoration.set(atomic, true), gutterMarkers: gutterBuilder.finish() };
}

export function createStoryDecorations(config: StoryConfig): { extensions: Extension[]; field: StateField<StoryState> } {
    const field = StateField.define<StoryState>({
        create(state) {
            return { model: null, expanded: new Set(), ...buildDecorations(state, null, new Set(), config) };
        },
        update(value, transaction: Transaction) {
            let model = value.model;
            let expanded = value.expanded;
            for (const effect of transaction.effects) {
                if (effect.is(DashQLStoryUpdateEffect)) {
                    const nextModel = buildStoryModel(effect.value, config.activation);
                    if (config.activation === 'toggle') {
                        const collapsed = new Set(model?.statements
                            .filter(statement => !expanded.has(statement.id))
                            .map(statement => statement.id));
                        expanded = new Set(nextModel?.statements
                            .filter(statement => !collapsed.has(statement.id))
                            .map(statement => statement.id));
                    } else {
                        expanded = new Set();
                    }
                    model = nextModel;
                } else if (effect.is(DashQLStoryToggleStatementEffect) && model?.statements.some(s => s.id === effect.value)) {
                    const nextExpanded = new Set(expanded);
                    nextExpanded.has(effect.value) ? nextExpanded.delete(effect.value) : nextExpanded.add(effect.value);
                    expanded = nextExpanded;
                }
            }
            if (model === value.model && expanded === value.expanded && !transaction.docChanged) return value;
            return { model, expanded, ...buildDecorations(transaction.state, model, expanded, config) };
        },
        provide: field => [
            EditorView.decorations.from(field, value => value.decorations),
            EditorView.atomicRanges.of(view => view.state.field(field).atomicRanges),
        ],
    });
    const foldGutter = gutter({
        class: 'dashql-story-fold-gutter',
        markers: view => view.state.field(field).gutterMarkers,
        initialSpacer: () => new StoryFoldSpacer(),
    });
    return {
        extensions: config.showGutter === false ? [field] : [lineNumbers(), field, foldGutter],
        field,
    };
}
