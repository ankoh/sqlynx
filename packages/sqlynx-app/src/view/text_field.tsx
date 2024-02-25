import * as React from 'react';
import { TextInput } from '@primer/react';
import { CopyIcon } from '@primer/octicons-react';

import { classNames } from '../utils/classnames.js';

import styles from './text_field.module.css';

export function TextField(props: {
    className?: string;
    name: string;
    caption: string;
    value: string;
    placeholder: string;
    leadingVisual?: React.ElementType;
    onChange: React.ChangeEventHandler<HTMLInputElement>;
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
        <div className={classNames(styles.text_field, props.className)}>
            <div className={styles.text_field_name}>{props.name}</div>
            <div className={styles.text_field_caption}>{props.caption}</div>
            <TextInput
                className={styles.text_field_input}
                block
                placeholder={props.placeholder}
                leadingVisual={props.leadingVisual}
                trailingAction={CopyAction()}
                value={props.value}
                onChange={props.onChange}
                readOnly={props.readOnly}
            />
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
    onChange: React.ChangeEventHandler<HTMLInputElement>;
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
                onChange={props.onChange}
                readOnly={props.readOnly}
            />
            <div className={styles.kv_field_input_value}>
                <TextInput
                    block
                    value={props.v}
                    placeholder={props.valuePlaceholder}
                    leadingVisual={props.valueIcon}
                    trailingAction={CopyAction()}
                    onChange={props.onChange}
                    readOnly={props.readOnly}
                />
            </div>
        </div>
    );
}
