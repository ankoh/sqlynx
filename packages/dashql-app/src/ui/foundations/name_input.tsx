import * as React from 'react';

interface Props {
    /// The persisted name, null if there is none
    name: string | null;
    /// Commit an edited name, blank input means no name
    onCommit: (name: string) => void;
    /// The accessible label
    ariaLabel: string;
    /// The placeholder while there is no name
    placeholder: string;
    /// The class of the input
    className?: string;
}

/// An editable name. The input owns its draft so typing does not rerender the surrounding view;
/// blur or Enter commits the draft, Escape restores the persisted name.
export const NameInput = React.forwardRef<HTMLInputElement, Props>((props, forwardedRef) => {
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    const cancelBlurRef = React.useRef(false);
    React.useImperativeHandle(forwardedRef, () => inputRef.current!, []);
    // Re-sync the draft when the persisted name changes (e.g. a rename from elsewhere, or switching
    // the named object while the input stays mounted).
    React.useEffect(() => {
        if (inputRef.current != null) inputRef.current.value = props.name ?? '';
    }, [props.name]);

    const commit = React.useCallback((e: React.FocusEvent<HTMLInputElement>) => {
        if (cancelBlurRef.current) {
            cancelBlurRef.current = false;
            return;
        }
        props.onCommit(e.currentTarget.value);
    }, [props.onCommit]);
    const onKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.currentTarget.blur();
        } else if (e.key === 'Escape') {
            // Abandon the edit: restore the persisted value and drop focus.
            cancelBlurRef.current = true;
            e.currentTarget.value = props.name ?? '';
            e.currentTarget.blur();
        }
        e.stopPropagation();
    }, [props.name]);
    const onPointerDown = React.useCallback((e: React.PointerEvent<HTMLInputElement>) => {
        // Inputs are often portaled from sortable rows. Keep selection gestures from bubbling
        // through the React tree and activating a drag sensor.
        e.stopPropagation();
    }, []);

    return (
        <input
            ref={inputRef}
            className={props.className}
            type="text"
            aria-label={props.ariaLabel}
            defaultValue={props.name ?? ''}
            placeholder={props.placeholder}
            spellCheck={false}
            onBlur={commit}
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
        />
    );
});
