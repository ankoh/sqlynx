import * as React from 'react';

export function useInlineRename(label: string, onRename: (newName: string) => void) {
    const [editing, setEditing] = React.useState(false);
    const [draftName, setDraftName] = React.useState(label);
    const inputRef = React.useRef<HTMLInputElement>(null);

    React.useEffect(() => {
        if (editing) {
            inputRef.current?.focus();
            inputRef.current?.select();
        }
    }, [editing]);

    const beginRename = () => {
        setDraftName(label);
        setEditing(true);
    };
    const saveRename = () => {
        const nextName = draftName.trim();
        setEditing(false);
        if (nextName && nextName !== label) onRename(nextName);
    };
    const handleKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            setDraftName(label);
            setEditing(false);
        }
    };

    return {
        editing,
        draftName,
        inputRef,
        beginRename,
        setDraftName,
        saveRename,
        handleKeyDown,
    };
}
