import * as React from 'react';
import * as styles from './select.module.css';

import { classNames } from '../../utils/classnames.js';
import { TriangleDownIcon } from './symbol_icon.js';

interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'className' | 'size' | 'multiple'> {
    className?: string;
    block?: boolean;
    /// An option with an empty value that is shown when nothing is selected.
    /// It can be selected again unless the select is required.
    placeholder?: string;
}

/// A native select that looks like a TextInput, modeled after the Select of @primer/react
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>((props, ref): React.ReactElement => {
    const { block, children, className, disabled, placeholder, required, ...selectProps } = props;
    return (
        <span className={classNames(styles.root, className, {
            [styles.root_disabled]: disabled,
            [styles.root_block]: block,
        })}>
            <select
                {...selectProps}
                ref={ref}
                className={styles.select}
                disabled={disabled}
                required={required}
            >
                {placeholder != null && (
                    <option value="" disabled={required} hidden={required}>{placeholder}</option>
                )}
                {children}
            </select>
            <TriangleDownIcon className={styles.arrow} size={16} />
        </span>
    );
});
