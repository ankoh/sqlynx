import * as React from 'react';
import * as styles from './json_view.module.css';

import icons from '@ankoh/dashql-svg-symbols';

import { useJsonViewerState } from './json_view_state.js';
import { useToolVisibility } from './json_tool_state.js';
import { bigIntToString } from './json_literal.js';
import { classNames } from '../../utils/classnames.js';

export interface SectionElementResult<T extends object, K = string | number> {
    value?: T;
    parentValue?: T;
    keyName?: K;
    keyPath?: K[];
}

export interface JsonCopyButtonProps<T extends object> extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'value'>, SectionElementResult<T> {
    expandKey: string;
    beforeCopy?: (
        copyText: string,
        keyName?: string | number,
        value?: T,
        parentValue?: T,
        expandKey?: string,
        keyPath?: (number | string)[],
    ) => string;
}

export function JsonCopyButton<T extends object>(props: JsonCopyButtonProps<T>) {
    const { keyName, value, parentValue, expandKey, keyPath, beforeCopy, ...other } = props;
    const { onCopied, enableClipboard, beforeCopy: globalBeforeCopy } = useJsonViewerState();
    const isShowTools = useToolVisibility(expandKey);
    const [copied, setCopied] = React.useState(false);

    if (enableClipboard === false || !isShowTools) return null;

    const click = (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => {
        event.stopPropagation();
        let copyText = '';
        if (typeof value === 'number' && value === Infinity) {
            copyText = 'Infinity';
        } else if (typeof value === 'number' && isNaN(value)) {
            copyText = 'NaN';
        } else if (typeof value === 'bigint') {
            copyText = bigIntToString(value);
        } else if (value instanceof Date) {
            copyText = value.toLocaleString();
        } else {
            copyText = JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? bigIntToString(v) : v), 2);
        }

        // Apply beforeCopy transformation if provided
        // Priority: component prop > global prop
        const finalBeforeCopy = beforeCopy || globalBeforeCopy;
        if (finalBeforeCopy && typeof finalBeforeCopy === 'function') {
            copyText = finalBeforeCopy(copyText, keyName, value, parentValue, expandKey, keyPath);
        }

        onCopied && onCopied(copyText, value);
        setCopied(true);

        const _clipboard = navigator.clipboard || {
            writeText(text: string) {
                return new Promise((reslove, reject) => {
                    const textarea = document.createElement('textarea');
                    textarea.style.position = 'absolute';
                    textarea.style.opacity = '0';
                    textarea.style.left = '-99999999px';
                    textarea.value = text;
                    document.body.appendChild(textarea);
                    textarea.select();
                    if (!document.execCommand('copy')) {
                        reject();
                    } else {
                        reslove();
                    }
                    textarea.remove();
                });
            },
        };

        _clipboard
            .writeText(copyText)
            .then(() => {
                const timer = setTimeout(() => {
                    setCopied(false);
                    clearTimeout(timer);
                }, 3000);
            })
            .catch((_error) => { });
    };

    const sym = copied ? "clipboard_copied" : "clipboard_copy";
    return (
        <button
            {...other}
            type="button"
            aria-label={copied ? 'JSON copied' : 'Copy JSON value'}
            className={classNames(styles.copy_button, {
                [styles.copy_button_copied]: copied
            })}
            onClick={click}
        >
            <svg viewBox="0 0 32 36" aria-hidden="true">
                <use xlinkHref={`${icons}#${sym}`} />
            </svg>
        </button>
    );
};
