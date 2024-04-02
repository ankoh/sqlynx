import * as React from 'react';
import { TextInput } from '@primer/react';
import { CopyIcon } from '@primer/octicons-react';

import { classNames } from '../utils/classnames.js';
import { VariantKind } from '../utils/variant.js';

import * as icons from '../../static/svg/symbols.generated.svg';

import styles from './text_field.module.css';

export const VALIDATION_UNKNOWN = Symbol("VALIDATION_UNKNOWN");
export const VALIDATION_OK = Symbol("VALIDATION_OK");
export const VALIDATION_WARNING = Symbol("VALIDATION_WARNING");
export const VALIDATION_ERROR = Symbol("VALIDATION_ERROR");

export type TextFieldValidationStatus =
    | VariantKind<typeof VALIDATION_UNKNOWN, null>
    | VariantKind<typeof VALIDATION_OK, null>
    | VariantKind<typeof VALIDATION_WARNING, string>
    | VariantKind<typeof VALIDATION_ERROR, string>;

function TextFieldValidation(props: { validation?: TextFieldValidationStatus }) {
    if (!props.validation) {
        return undefined;
    }
    switch (props.validation.type) {
        case VALIDATION_OK:
        case VALIDATION_UNKNOWN: {
            return undefined;
        }
        case VALIDATION_WARNING: {
            return (
                <div className={styles.text_field_validation_warning}>
                    <svg className={styles.text_field_validation_icon} width="12px" height="12px">
                        <use xlinkHref={`${icons}#alert_fill_12`} />
                    </svg>
                    <span className={styles.text_field_validation_text}>
                        {props.validation.value}
                    </span>
                </div>
            );
        }
        case VALIDATION_ERROR: {
            return (
                <div className={styles.text_field_validation_error}>
                    <svg className={styles.text_field_validation_icon} width="12px" height="12px">
                        <use xlinkHref={`${icons}#alert_fill_12`} />
                    </svg>
                    <span className={styles.text_field_validation_text}>
                        {props.validation.value}
                    </span>
                </div>
            );
        }

    }
}

export function TextField(props: {
    className?: string;
    name: string;
    caption?: string;
    value: string;
    placeholder?: string;
    leadingVisual?: React.ElementType;
    onChange?: React.ChangeEventHandler<HTMLInputElement>;
    disabled?: boolean;
    readOnly?: boolean;
    validation?: TextFieldValidationStatus;
}) {
    const CopyAction = () => (
        <TextInput.Action
            onClick={() => {
                alert('clear input');
            }}
            icon={CopyIcon}
            aria-label="Clear input"
        />
    );
    let validationStatus: undefined | "error" | "success" = undefined;
    if (props.validation?.type === VALIDATION_OK) {
        validationStatus = 'success';
    } else if (props.validation?.type === VALIDATION_ERROR) {
        validationStatus = 'error';
    }
    return (
        <div className={classNames(styles.text_field, props.className)}>
            <div className={styles.text_field_name}>{props.name}</div>
            {props.caption && <div className={styles.text_field_caption}>{props.caption}</div>}
            <TextInput
                className={styles.text_field_input}
                block
                placeholder={props.placeholder}
                leadingVisual={props.leadingVisual}
                trailingAction={CopyAction()}
                value={props.value}
                onChange={props.onChange}
                disabled={props.disabled}
                readOnly={props.readOnly}
                validationStatus={validationStatus}
            />
            <TextFieldValidation validation={props.validation} />
        </div>
    );
}

export function KeyValueTextField(props: {
    className?: string;
    name: string;
    caption: string;
    k: string;
    v: string;
    keyPlaceholder: string;
    valuePlaceholder: string;
    keyIcon?: React.ElementType;
    valueIcon?: React.ElementType;
    onChangeKey: React.ChangeEventHandler<HTMLInputElement>;
    onChangeValue: React.ChangeEventHandler<HTMLInputElement>;
    disabled?: boolean;
    readOnly?: boolean;
}) {
    const CopyAction = () => (
        <TextInput.Action
            onClick={() => {
                alert('clear input');
            }}
            icon={CopyIcon}
            aria-label="Clear input"
        />
    );
    return (
        <div className={classNames(styles.kv_field, props.className)}>
            <div className={styles.kv_field_name}>{props.name}</div>
            <div className={styles.kv_field_caption}>{props.caption}</div>
            <TextInput
                className={styles.kv_field_input_key}
                block
                value={props.k}
                placeholder={props.keyPlaceholder}
                leadingVisual={props.keyIcon}
                trailingAction={CopyAction()}
                onChange={props.onChangeKey}
                readOnly={props.readOnly}
                disabled={props.disabled}
            />
            <div className={styles.kv_field_input_value}>
                <TextInput
                    block
                    value={props.v}
                    placeholder={props.valuePlaceholder}
                    leadingVisual={props.valueIcon}
                    trailingAction={CopyAction()}
                    onChange={props.onChangeValue}
                    readOnly={props.readOnly}
                    disabled={props.disabled}
                />
            </div>
        </div>
    );
}
