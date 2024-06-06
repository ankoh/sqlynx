import * as React from 'react';
import { classNames } from '../../utils/classnames.js';

import * as styles from './text_input.module.css';
import { VALIDATION_ERROR } from '../text_field.js';

// import { CopyToClipboardAction } from '../../utils/clipboard.js';
// import * as React from 'react';
//
// className={classNames(styles.text_field_input, {
//     [styles.text_field_disabled]: props.disabled
// })}
// block
// placeholder={props.placeholder}
// leadingVisual={props.leadingVisual}
// trailingAction={<CopyToClipboardAction value={props.value} logContext={props.logContext} ariaLabel={`Copy ${props.name}`} />}
// value={value}
// onChange={props.onChange}
// disabled={props.disabled}
// readOnly={props.readOnly}
// validationStatus={validationStatus}

export enum TextInputValidationStatus {
    Success = 1,
    Error = 2,
}

interface TextInputProps {
    className?: string;
    value?: string;
    placeholder?: string;
    leadingVisual?: React.ReactElement;
    trailingVisual?: React.ReactElement;
    trailingAction?: React.ReactElement;
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
                    {props.leadingVisual}
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
                    {props.trailingVisual}
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
