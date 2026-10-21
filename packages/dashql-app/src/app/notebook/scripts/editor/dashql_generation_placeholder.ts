import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

import * as styles from './dashql_generation_placeholder.module.css';

/// Effect to show or hide the placeholder of the SQL that is being generated
export const DashQLGenerationPlaceholderEffect = StateEffect.define<boolean>();

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
export const DashQLGenerationPlaceholder = StateField.define<boolean>({
    create: () => false,
    update: (shown, tr) => {
        for (const effect of tr.effects) {
            if (effect.is(DashQLGenerationPlaceholderEffect)) shown = effect.value;
        }
        return shown;
    },
    provide: field => EditorView.decorations.compute([field, 'doc'], state => state.field(field)
        ? Decoration.set([
            Decoration.widget({ widget: new GenerationPlaceholderWidget(), block: true, side: 1 }).range(state.doc.length),
        ])
        : Decoration.none),
});
