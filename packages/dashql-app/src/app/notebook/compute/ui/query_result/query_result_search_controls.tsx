import * as React from 'react';

import { Button, ButtonSize, ButtonVariant } from '../../../../../ui/foundations/button.js';
import { SearchIcon, XIcon } from '../../../../../ui/foundations/symbol_icon.js';
import { TextInput } from '../../../../../ui/foundations/text_input.js';
import { TextInputAction } from '../../../../../ui/foundations/text_input_action.js';
import type { ResultSearchState } from '../../../../../compute/computation_types.js';
import * as styles from './query_result_search_controls.module.css';

/// Data searches run SQL over the whole result, so they only start once typing pauses
const DATA_SEARCH_DEBOUNCE_MS = 200;

interface SearchControlProps {
    kind: 'Columns' | 'Data';
    state: ResultSearchState;
    expanded: boolean;
    onExpand: () => void;
    onCollapse: () => void;
    onChange: (value: string) => void;
    matchCount: number | null;
    /// Delay before a typed pattern is propagated, 0 propagates immediately
    debounceMs?: number;
}

function SearchControl(props: SearchControlProps) {
    const inputRef = React.useRef<HTMLInputElement>(null);
    const buttonRef = React.useRef<HTMLButtonElement>(null);
    const inputId = React.useId();
    React.useEffect(() => {
        if (props.expanded) inputRef.current?.focus();
    }, [props.expanded]);

    // Keep the input responsive with a local value and propagate it debounced
    const requestedPattern = props.state.requestedPattern;
    const [pattern, setPattern] = React.useState(requestedPattern);
    const pendingChange = React.useRef<{ timer: ReturnType<typeof setTimeout>; value: string } | null>(null);
    const onChangeRef = React.useRef(props.onChange);
    onChangeRef.current = props.onChange;
    const flushChange = React.useCallback(() => {
        const pending = pendingChange.current;
        if (pending == null) return;
        clearTimeout(pending.timer);
        pendingChange.current = null;
        onChangeRef.current(pending.value);
    }, []);
    const changePattern = React.useCallback((value: string, immediate: boolean) => {
        setPattern(value);
        const pending = pendingChange.current;
        if (pending != null) {
            clearTimeout(pending.timer);
            pendingChange.current = null;
        }
        const debounceMs = props.debounceMs ?? 0;
        if (immediate || debounceMs <= 0) {
            onChangeRef.current(value);
            return;
        }
        pendingChange.current = { timer: setTimeout(flushChange, debounceMs), value };
    }, [props.debounceMs, flushChange]);
    // Adopt patterns that change from outside while no local edit is pending
    React.useEffect(() => {
        if (pendingChange.current == null) setPattern(requestedPattern);
    }, [requestedPattern]);
    // Don't drop a pending edit when the control unmounts
    React.useEffect(() => () => flushChange(), [flushChange]);

    return (
        <div className={styles.control} aria-busy={props.state.pending || undefined}>
            {props.expanded ? (
                <TextInput
                    ref={inputRef}
                    id={inputId}
                    className={styles.input}
                    aria-label={`Search ${props.kind.toLowerCase()}`}
                    placeholder={`Search ${props.kind.toLowerCase()}`}
                    leadingVisual={SearchIcon}
                    value={pattern}
                    onChange={event => changePattern(event.target.value, false)}
                    onBlur={() => {
                        if (pattern.length === 0) {
                            props.onCollapse();
                        }
                    }}
                    onKeyDown={event => {
                        if (event.key === 'Escape') {
                            if (pattern.length === 0) {
                                event.preventDefault();
                                props.onCollapse();
                                requestAnimationFrame(() => buttonRef.current?.focus());
                            }
                        }
                    }}
                    trailingAction={(
                        <TextInputAction
                            aria-label={`Close ${props.kind.toLowerCase()} search`}
                            aria-labelledby=""
                            onClick={() => {
                                changePattern('', true);
                                props.onCollapse();
                                requestAnimationFrame(() => buttonRef.current?.focus());
                            }}
                        >
                            <XIcon />
                        </TextInputAction>
                    )}
                />
            ) : (
                <Button
                    ref={buttonRef}
                    className={styles.button}
                    variant={ButtonVariant.Invisible}
                    size={ButtonSize.Small}
                    leadingVisual={SearchIcon}
                    aria-expanded={false}
                    aria-controls={inputId}
                    onClick={props.onExpand}
                    title={`${props.kind} search`}
                >
                    {props.kind}
                </Button>
            )}
            {props.state.error != null && (
                <span className={styles.error} title={props.state.error} aria-label={`${props.kind} search failed`}>
                    !
                </span>
            )}
            <span className={styles.status} role="status">
                {props.state.error
                    ?? (props.state.pending
                        ? `Searching ${props.kind.toLowerCase()}`
                        : (props.state.requestedPattern.length > 0 && props.matchCount != null
                            ? `${props.kind} search complete, ${props.matchCount} matching ${props.kind.toLowerCase()}`
                            : ''))}
            </span>
        </div>
    );
}

interface Props {
    columnSearch: ResultSearchState;
    dataSearch: ResultSearchState;
    onColumnPatternChange: (value: string) => void;
    onDataPatternChange: (value: string) => void;
    columnMatchCount: number | null;
    dataMatchCount: number | null;
}

export function QueryResultSearchControls(props: Props) {
    const [columnsExpanded, setColumnsExpanded] = React.useState(() => props.columnSearch.requestedPattern.length > 0);
    const [dataExpanded, setDataExpanded] = React.useState(() => props.dataSearch.requestedPattern.length > 0);
    return (
        <>
            <SearchControl
                kind="Columns"
                state={props.columnSearch}
                expanded={columnsExpanded}
                onExpand={() => setColumnsExpanded(expanded => !expanded)}
                onCollapse={() => setColumnsExpanded(false)}
                onChange={props.onColumnPatternChange}
                matchCount={props.columnMatchCount}
            />
            <SearchControl
                kind="Data"
                state={props.dataSearch}
                expanded={dataExpanded}
                onExpand={() => setDataExpanded(expanded => !expanded)}
                onCollapse={() => setDataExpanded(false)}
                onChange={props.onDataPatternChange}
                matchCount={props.dataMatchCount}
                debounceMs={DATA_SEARCH_DEBOUNCE_MS}
            />
        </>
    );
}
