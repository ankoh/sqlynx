import * as React from 'react';
import { TextInput } from '@primer/react';
import { CopyIcon } from '@primer/octicons-react';

import styles from './text_field.module.css';

export function TextField(props: {
    name: string;
    caption: string;
    value: string;
    leadingVisual?: React.ElementType;
    onChange: React.ChangeEventHandler<HTMLInputElement>;
    disabled?: boolean;
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
        <div className={styles.text_field}>
            <div className={styles.text_field_name}>{props.name}</div>
            <div className={styles.text_field_caption}>{props.caption}</div>
            <TextInput
                className={styles.text_field_input}
                block
                leadingVisual={props.leadingVisual}
                trailingAction={CopyAction()}
                value={props.value}
                onChange={props.onChange}
            />
        </div>
    );
}

export function KeyValueTextField(props: {
    name: string;
    caption: string;
    k: string;
    v: string;
    keyIcon?: React.ElementType;
    valueIcon?: React.ElementType;
    onChange: React.ChangeEventHandler<HTMLInputElement>;
    disabled?: boolean;
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
        <div className={styles.kv_field}>
            <div className={styles.kv_field_name}>{props.name}</div>
            <div className={styles.kv_field_caption}>{props.caption}</div>
            <TextInput
                className={styles.kv_field_input_key}
                block
                leadingVisual={props.keyIcon}
                trailingAction={CopyAction()}
                value={props.k}
                onChange={props.onChange}
            />
            <div className={styles.kv_field_input_value}>
                <TextInput
                    block
                    leadingVisual={props.valueIcon}
                    trailingAction={CopyAction()}
                    value={props.v}
                    onChange={props.onChange}
                />
            </div>
        </div>
    );
}
