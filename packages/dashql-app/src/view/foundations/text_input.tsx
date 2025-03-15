import * as React from 'react';
import * as styles from './text_input.module.css';

import { classNames } from '../../utils/classnames.js';

export enum TextInputValidationStatus {
    Success = 1,
    Warning = 2,
    Error = 3,
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
    autoComplete?: boolean;
}

export function TextInput(props: TextInputProps): React.ReactElement {
    return (
        <span className={classNames(styles.root, props.className, {
            [styles.root_disabled]: props.disabled,
            [styles.root_block]: props.block,
            [styles.root_validation_success]: props.validationStatus == TextInputValidationStatus.Success,
            [styles.root_validation_warning]: props.validationStatus == TextInputValidationStatus.Warning,
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
                autoComplete={props.autoComplete?.toString()}
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
