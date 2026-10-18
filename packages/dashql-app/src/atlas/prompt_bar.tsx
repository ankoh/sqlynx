import * as React from 'react';

import { PaperAirplaneIcon } from '../ui/foundations/symbol_icon.js';
import * as styles from './prompt_bar.module.css';

interface PromptBarProps {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    placeholder: string;
    /// A search is running, the text stays but cannot be changed or sent
    busy?: boolean;
    /// Small actions on the left of the second row
    start?: React.ReactNode;
    /// Small actions or information on the right of the second row
    end?: React.ReactNode;
}

/// A rounded prompt that grows toward the top with its text, like the prompt of a chat client. Enter sends, Shift+Enter
/// starts a new line. The second row holds small actions.
export const PromptBar: React.FC<PromptBarProps> = (props: PromptBarProps) => {
    const inputRef = React.useRef<HTMLTextAreaElement>(null);
    const canSubmit = !props.busy && props.value.trim().length > 0;

    // The height follows the content, CSS limits it and the text scrolls beyond that
    const fit = React.useCallback(() => {
        const input = inputRef.current;
        if (input == null) return;
        input.style.height = 'auto';
        input.style.height = `${input.scrollHeight}px`;
    }, []);
    React.useLayoutEffect(fit, [fit, props.value]);
    // Lines wrap differently when the width changes
    React.useEffect(() => {
        const input = inputRef.current;
        if (input == null) return;
        let width = input.clientWidth;
        const observer = new ResizeObserver(() => {
            if (input.clientWidth === width) return;
            width = input.clientWidth;
            fit();
        });
        observer.observe(input);
        return () => observer.disconnect();
    }, [fit]);

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
        e.preventDefault();
        if (canSubmit) props.onSubmit();
    };

    return (
        <form
            className={styles.bar}
            onSubmit={e => {
                e.preventDefault();
                if (canSubmit) props.onSubmit();
            }}
        >
            <div className={styles.input_row}>
                <textarea
                    ref={inputRef}
                    className={styles.input}
                    rows={1}
                    autoFocus
                    value={props.value}
                    placeholder={props.placeholder}
                    aria-label="Search prompt"
                    readOnly={props.busy}
                    onChange={e => props.onChange(e.target.value)}
                    onKeyDown={onKeyDown}
                />
                <button type="submit" className={styles.send} aria-label="Search" title="Search" disabled={!canSubmit}>
                    <PaperAirplaneIcon size={16} />
                </button>
            </div>
            <div className={styles.action_row}>
                <div className={styles.actions_start}>{props.start}</div>
                <div className={styles.actions_end}>{props.end}</div>
            </div>
        </form>
    );
};

interface PromptActionProps {
    icon?: React.ReactElement;
    onClick: () => void;
    disabled?: boolean;
    children: React.ReactNode;
}

/// A small action in the second row of the prompt
export const PromptAction: React.FC<PromptActionProps> = (props: PromptActionProps) => (
    <button type="button" className={styles.action} disabled={props.disabled} onClick={props.onClick}>
        {props.icon}
        <span>{props.children}</span>
    </button>
);
