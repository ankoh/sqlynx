import * as React from 'react';
import { classNames } from '../../utils/classnames.js';

import * as styles from './text_input.module.css';

export enum TextInputValidationStatus {
    Success = 1,
    Error = 2,
}

interface TextInputProps {
    className?: string;
    value?: string;
    placeholder?: string;
    leadingVisual?: React.ElementType;
    trailingVisual?: React.ElementType;
    trailingAction?: React.ReactElement<React.HTMLProps<HTMLButtonElement>>;
    onChange?: React.ChangeEventHandler;
    disabled?: boolean;
    readOnly?: boolean;
    block?: boolean;
    validationStatus?: TextInputValidationStatus;
}

export function TextInput(props: TextInputProps): React.ReactElement {
    return (
        <span className={classNames(styles.root, props.className, {
            [styles.root_disabled]: props.disabled,
            [styles.root_block]: props.block,
            [styles.root_validation_success]: props.validationStatus == TextInputValidationStatus.Success,
            [styles.root_validation_error]: props.validationStatus == TextInputValidationStatus.Error,
        })}>
            {props.leadingVisual && (
                <span className={styles.leading_visual_container}>
                    {<props.leadingVisual />}
                </span>
            )}
            <input
                className={styles.input_container}
                value={props.value}
                readOnly={props.readOnly}
                placeholder={props.placeholder}
                disabled={props.disabled}
                onChange={props.onChange}
            />
            {props.trailingVisual && (
                <span className={styles.trailing_visual_container}>
                    {<props.trailingVisual />}
                </span>
            )}
            {props.trailingAction && (
                <span className={styles.trailing_action_container}>
                    {props.trailingAction}
                </span>
            )}
        </span>
    );
}
