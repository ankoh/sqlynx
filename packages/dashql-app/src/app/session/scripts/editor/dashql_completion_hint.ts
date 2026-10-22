import * as dashql from '@ankoh/dashql-core';

import { Range } from '@codemirror/state';
import { EditorView, Decoration, DecorationSet, WidgetType, ViewPlugin, ViewUpdate } from '@codemirror/view';

import { DashQLCompletionState, DashQLProcessorPlugin } from './dashql_processor.js';
import { CompletionPatch, PATCH_DELETE_TEXT, PATCH_INSERT_TEXT, CompletionPatchTarget, TextAnchor } from './dashql_completion_patches.js';

import symbols from '@ankoh/dashql-svg-symbols';

import * as styles from './dashql_completion_hint.module.css';

const HINT_PRIORITY_MAX = 10000;

type Hint = CompletionPatch & {
    /// Should we render the category controls for the user?
    /// We want to hint the user that he can click certain keys to apply a patch.
    controls: boolean;
};

interface CompletionHints {
    /// The candidate completion hint
    candidateHints: Hint[];
    /// The qualifier for the candidate
    catalogObjectHints: Hint[];
}

function selectControls(hints: Hint[], preferFirst: boolean) {
    let firstInsert: number | null = null;
    let firstDelete: number | null = null;
    let lastInsert: number | null = null;
    let lastDelete: number | null = null;

    // Determine the first inserts & deletes
    for (let i = 0; i < hints.length; ++i) {
        const hint = hints[i];
        if (hint.type == PATCH_INSERT_TEXT && firstInsert == null) {
            firstInsert = i;
        }
        if (hint.type == PATCH_DELETE_TEXT && firstDelete == null) {
            firstDelete = i;
        }
        if (firstInsert != null && firstDelete != null) {
            break;
        }
    }

    // Determine the last inserts & deletes
    for (let i = hints.length - 1; i >= 0; --i) {
        const hint = hints[i];
        if (hint.type == PATCH_INSERT_TEXT && lastInsert == null) {
            lastInsert = i;
        }
        if (hint.type == PATCH_DELETE_TEXT && lastDelete == null) {
            lastDelete = i;
        }
        if (lastInsert != null && lastDelete != null) {
            break;
        }
    }
    // Select the hint with controls
    let controlsAt = null;
    if (preferFirst) {
        controlsAt = firstInsert != null ? firstInsert : firstDelete;
    } else {
        controlsAt = lastInsert != null ? lastInsert : lastDelete;
    }
    if (controlsAt != null) {
        hints[controlsAt].controls = true;
    }
}

/// Helper to compute the completion hints given a completion candidate a new editor state
export function deriveCompletionHints(state: DashQLCompletionState): CompletionHints {
    const hints: CompletionHints = {
        candidateHints: state.candidatePatch.map(p => ({ ...p, controls: false })),
        catalogObjectHints: state.catalogObjectPatch.map(p => ({ ...p, controls: false })),
    };
    selectControls(hints.candidateHints, false);
    selectControls(hints.catalogObjectHints, true);
    return hints;
}

const INSERT_CLASSNAMES = [
    styles.hint_candidate_insert,
    styles.hint_qualification_insert,
];
const DELETE_CLASSNAMES = [
    styles.hint_candidate_delete,
    styles.hint_qualification_delete,
];
function getInsertClassNameForCategory(category: CompletionPatchTarget): string {
    return INSERT_CLASSNAMES[category as number - 1];
}
function getDeleteClassNameForCategory(category: CompletionPatchTarget): string {
    return DELETE_CLASSNAMES[category as number - 1];
}

export class InsertPatchWidget extends WidgetType {
    constructor(
        protected text: string,
        protected className: string
    ) {
        super();
    }
    eq(other: InsertPatchWidget): boolean {
        return this.text === other.text;
    }
    toDOM(): HTMLElement {
        const span = document.createElement('span');
        span.className = this.className;
        span.textContent = this.text;
        span.style.lineHeight = '0';
        return span;
    }
    get estimatedHeight(): number {
        // Inline hints must not make an otherwise empty editor line taller.
        return 0;
    }
}

class HintKeyWidget extends WidgetType {
    constructor(
        protected n: number | null,
    ) {
        super();
    }
    eq(other: HintKeyWidget): boolean {
        return this.n == other.n;
    }
    toDOM(): HTMLElement {
        const span = document.createElement('span');

        // Create the inner span with hint_ctrl_overlap_container class
        const innerSpan = document.createElement('span');
        innerSpan.className = styles.hint_ctrl_overlap_container;

        // Create the label for the counter (if we have one)
        if (this.n != null) {
            const labelSpan = document.createElement('span');
            labelSpan.className = styles.hint_ctrl_label;
            labelSpan.textContent = String(this.n);
            innerSpan.appendChild(labelSpan);
        }

        // Create the SVG element
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '10px');
        svg.setAttribute('height', '10px');
        const svgSymbol = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        svgSymbol.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', `${symbols}#keyboard_tab_24`);
        svg.appendChild(svgSymbol);

        innerSpan.appendChild(svg);
        span.appendChild(innerSpan);

        span.className = styles.hint_ctrl_container;
        return span;
    }
    get estimatedHeight(): number {
        return -1; // Use line height
    }
}

function computeCompletionHintDecorations(viewUpdate: ViewUpdate): DecorationSet {
    const processor = viewUpdate.state.field(DashQLProcessorPlugin);

    // Find the selected completion
    if (processor.scriptCompletion == null || processor.editorUpdate?.primaryCursorState == null) {
        return Decoration.none;
    }
    const isPassive = processor.scriptCompletion.passiveHint;

    // Suppress the inline hint when the selected candidate has an incompatible suffix.
    const completionBuffer = processor.scriptCompletion.buffer.read();
    const selectedCandidate = completionBuffer.candidates(processor.scriptCompletion.candidateId);
    if (selectedCandidate != null
        && (selectedCandidate.candidateTags()! & dashql.buffers.completion.CandidateTag.SUFFIX_INCOMPATIBLE) != 0) {
        return Decoration.none;
    }

    // Compute the new completion hints
    const hints = deriveCompletionHints(processor.scriptCompletion);
    if (hints == null) {
        return Decoration.none;
    }

    // Merge all hints.
    // Codemirror requires Decorations to be ordered by `at` & `side`
    const mergedPatches = [
        ...hints.candidateHints,
        ...hints.catalogObjectHints
    ];
    mergedPatches.sort((l, r) => {
        let a = l.value.at;
        let b = r.value.at;
        if (a != b) {
            return a - b;
        }
        switch (l.type) {
            case PATCH_INSERT_TEXT:
                a = (l.value.textAnchor as number) * (l.target as number);
                break;
            case PATCH_DELETE_TEXT:
                a = (l.target as number) * HINT_PRIORITY_MAX;
                break;
        }
        switch (r.type) {
            case PATCH_INSERT_TEXT:
                b = (r.value.textAnchor as number) * (r.target as number);
                break;
            case PATCH_DELETE_TEXT:
                b = (r.target as number) * HINT_PRIORITY_MAX
                break;
        }
        return a - b;
    });

    // Create decorations
    const decorations: Range<Decoration>[] = [];
    for (const patch of mergedPatches) {
        switch (patch.type) {
            case PATCH_INSERT_TEXT: {
                const side = (patch.value.textAnchor == TextAnchor.Left ? 1 : -1) * (patch.target as number);

                /// Construct the insert widget
                const insertClassname = getInsertClassNameForCategory(patch.target);
                const insertWidget = new InsertPatchWidget(patch.value.text, insertClassname);
                const insertDeco = Decoration.widget({ widget: insertWidget, side }).range(patch.value.at);
                decorations.push(insertDeco);

                // Insert controls after?
                if (patch.controls && !isPassive) {
                    const controlsWidget = new HintKeyWidget(null);
                    const controlDeco = Decoration.widget({ widget: controlsWidget, side }).range(patch.value.at);
                    decorations.push(controlDeco);
                }
                break;
            }
            case PATCH_DELETE_TEXT:
                // Construct the deletion widget
                const deleteClassName = getDeleteClassNameForCategory(patch.target);
                const deleteDeco = Decoration.mark({ class: deleteClassName }).range(patch.value.at, patch.value.at + patch.value.length);
                decorations.push(deleteDeco);

                // Emit controls?
                if (patch.controls && !isPassive) {
                    const controlsWidget = new HintKeyWidget(null);
                    const controlDeco = Decoration.widget({ widget: controlsWidget }).range(patch.value.at);
                    decorations.push(controlDeco);
                }
                break;
        }
    }
    return Decoration.set(decorations);
};

export const DashQLCompletionHintPlugin = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;
        constructor(readonly view: EditorView) {
            this.decorations = Decoration.none;
        }
        update(u: ViewUpdate) {
            const next = computeCompletionHintDecorations(u);
            if (next !== this.decorations) {
                this.decorations = next;
            }
        }
    },
    { decorations: v => v.decorations }
);
