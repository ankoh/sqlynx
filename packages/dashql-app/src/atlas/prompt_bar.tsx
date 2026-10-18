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
    /// There is nothing to search yet
    disabled?: boolean;
    /// Information below the text
    info?: React.ReactNode;
}

/// A rounded prompt that grows with its text, like the prompt of a chat client. Enter sends, Shift+Enter
/// starts a new line.
export const PromptBar: React.FC<PromptBarProps> = (props: PromptBarProps) => {
    const inputRef = React.useRef<HTMLTextAreaElement>(null);
    const canSubmit = !props.busy && !props.disabled && props.value.trim().length > 0;

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
            className={props.disabled ? `${styles.bar} ${styles.bar_disabled}` : styles.bar}
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
                    value={props.value}
                    placeholder={props.placeholder}
                    aria-label="Search prompt"
                    readOnly={props.busy}
                    disabled={props.disabled}
                    onChange={e => props.onChange(e.target.value)}
                    onKeyDown={onKeyDown}
                />
                <button type="submit" className={styles.send} aria-label="Search" title="Search" disabled={!canSubmit}>
                    <PaperAirplaneIcon size={16} />
                </button>
            </div>
            {props.info != null && <div className={styles.info}>{props.info}</div>}
        </form>
    );
};
