import { Prec } from '@codemirror/state';
import { EditorView, keymap, KeyBinding } from '@codemirror/view';

import { DashQLDiffAcceptEffect, DashQLDiffRejectEffect, DashQLProcessorPlugin } from './dashql_processor.js';

/// Accept the pending diff: keep the current (new) text and clear the overlay.
export function acceptPendingDiff(view: EditorView): boolean {
    const processor = view.state.field(DashQLProcessorPlugin);
    if (processor.scriptPendingDiff == null) {
        return false;
    }
    view.dispatch({ effects: DashQLDiffAcceptEffect.of(null) });
    return true;
}

/// Reject the pending diff: restore the prior text verbatim and clear the overlay.
export function rejectPendingDiff(view: EditorView): boolean {
    const processor = view.state.field(DashQLProcessorPlugin);
    const pending = processor.scriptPendingDiff;
    if (pending == null) {
        return false;
    }
    // Restore the prior text in the same transaction that clears the overlay. The processor's
    // docChanged branch mirrors the restore to the WASM rope; `updateDiff` sees the reject effect
    // and clears the pending diff before the auto-accept check can fire.
    view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: pending.priorText },
        effects: DashQLDiffRejectEffect.of(null),
    });
    return true;
}

/// Enter accepts, Escape rejects. Both no-op (return false, letting the key fall through) when no
/// diff is pending, and defer to an active completion via lower precedence than the completion
/// keymap (which is registered at Prec.highest).
///
/// The Accept/Reject *buttons* live in the card body, not in a panel inside the editor. This keymap
/// keeps the Enter/Escape shortcuts working while the diff editor holds focus.
const KEYBINDINGS: KeyBinding[] = [
    { key: 'Enter', run: acceptPendingDiff },
    { key: 'Escape', run: rejectPendingDiff },
];

export const DashQLDiffHintPlugin = [
    Prec.high(keymap.of(KEYBINDINGS)),
];
