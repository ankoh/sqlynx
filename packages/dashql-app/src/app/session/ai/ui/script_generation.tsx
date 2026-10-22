import * as React from 'react';
import * as styles from './script_generation.module.css';

import type { EditorView } from '@codemirror/view';

import { ButtonSize, ButtonVariant, IconButton } from '../../../../ui/foundations/button.js';
import { SquareFillIcon, SymbolIcon } from '../../../../ui/foundations/symbol_icon.js';
import { setGenerationPlaceholder } from '../editor/generation_placeholder.js';
import type { ScriptGeneration } from '../use_sql_generations.js';

const CrossIcon = SymbolIcon('x_16');

/// Is the SQL of a script being generated?
export function isGenerating(generation: ScriptGeneration | null): boolean {
    return generation != null && generation.error == null;
}

/// Mark where the generated SQL will appear in the editor of a script.
/// Synced after every render, the script editor replaces its state when the script session changes.
export function useGenerationPlaceholder(view: EditorView | null, generating: boolean): void {
    React.useEffect(() => {
        if (view?.state != null) setGenerationPlaceholder(view, generating);
    });
}

interface GenerationStopButtonProps {
    /// The script whose SQL is being generated
    scriptKey: number | null;
    /// The display name of the script
    displayName: string;
    /// Stop the generation of the script
    onStop: (scriptKey: number) => void;
}

/// Stops the generation of the SQL of a script, takes the place of the execute button
export const GenerationStopButton: React.FC<GenerationStopButtonProps> = (props) => (
    <IconButton
        variant={ButtonVariant.Invisible}
        size={ButtonSize.Small}
        aria-label={`Stop generating ${props.displayName} query`}
        onClick={() => {
            if (props.scriptKey != null) props.onStop(props.scriptKey);
        }}
    >
        <SquareFillIcon size={14} />
    </IconButton>
);

interface GenerationErrorProps {
    /// The script whose generation failed
    scriptKey: number | null;
    /// The generation of the script
    generation: ScriptGeneration | null;
    /// Dismiss the error of the script
    onDismiss: (scriptKey: number) => void;
}

/// The error of a failed generation until it is dismissed
export const GenerationError: React.FC<GenerationErrorProps> = (props) => {
    if (props.generation?.error == null) {
        return null;
    }
    return (
        <div className={styles.generation_error} role="alert">
            <span className={styles.generation_error_message}>{props.generation.error}</span>
            <IconButton
                variant={ButtonVariant.Invisible}
                size={ButtonSize.Small}
                aria-label="Dismiss the error"
                onClick={() => {
                    if (props.scriptKey != null) props.onDismiss(props.scriptKey);
                }}
            >
                <CrossIcon size={14} />
            </IconButton>
        </div>
    );
};
