import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

import * as styles from './generation_placeholder.module.css';

/// Effect to show or hide the placeholder of the SQL that is being generated
export const GenerationPlaceholderEffect = StateEffect.define<boolean>();

/// A shimmering line below the script that marks where the generated SQL will appear
class GenerationPlaceholderWidget extends WidgetType {
    eq() {
        return true;
    }
    toDOM() {
        const line = document.createElement('div');
        line.className = styles.placeholder_line;
        line.setAttribute('role', 'status');
        line.setAttribute('aria-label', 'Generating SQL');
        const bar = document.createElement('span');
        bar.className = styles.placeholder_bar;
        line.appendChild(bar);
        return line;
    }
}

/// Is the generation placeholder shown?
/// Block widgets must be provided by a state field, the placeholder follows the end of the document.
export const GenerationPlaceholder = StateField.define<boolean>({
    create: () => false,
    update: (shown, tr) => {
        for (const effect of tr.effects) {
            if (effect.is(GenerationPlaceholderEffect)) shown = effect.value;
        }
        return shown;
    },
    provide: field => EditorView.decorations.compute([field, 'doc'], state => state.field(field)
        ? Decoration.set([
            Decoration.widget({ widget: new GenerationPlaceholderWidget(), block: true, side: 1 }).range(state.doc.length),
        ])
        : Decoration.none),
});

/// Show or hide the generation placeholder of an editor.
/// Editors start without the placeholder field, the first time it is shown installs it.
export function setGenerationPlaceholder(view: EditorView, shown: boolean): void {
    const current = view.state.field(GenerationPlaceholder, false);
    if (current === undefined) {
        if (shown) view.dispatch({ effects: StateEffect.appendConfig.of(GenerationPlaceholder.init(() => true)) });
    } else if (current !== shown) {
        view.dispatch({ effects: GenerationPlaceholderEffect.of(shown) });
    }
}
