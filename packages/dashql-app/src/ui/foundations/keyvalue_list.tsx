import * as React from 'react';

import * as styles from './keyvalue_list.module.css';

import { Dispatch } from '../../utils/variant.js';
import { PlusIcon, XIcon } from './symbol_icon.js';
import { classNames } from '../../utils/classnames.js';
import { TextInput } from './text_input.js';
import { TextInputAction } from './text_input_action.js';
import { ButtonSize, ButtonVariant, IconButton } from './button.js';
import { CopyToClipboardButton } from '../../utils/clipboard.js';

export interface KeyValueListElement {
    key: string;
    value: string;
}

export type UpdateKeyValueList = (prev: KeyValueListElement[]) => KeyValueListElement[];

interface Props {
    className?: string;
    title: string;
    caption: string;
    keyIcon: React.ElementType;
    valueIcon: React.ElementType;
    addButtonLabel: string;
    elements: readonly KeyValueListElement[];
    modifyElements: Dispatch<UpdateKeyValueList>;
    disabled?: boolean;
    readOnly?: boolean;
    sideBySide?: boolean;
    copyValue?: (element: KeyValueListElement) => string;
    copyLogContext?: string;
}

export const KeyValueListBuilder: React.FC<Props> = (props: Props) => {
    const appendElement = () => props.modifyElements(list => {
        const copy = [...list];
        copy.push({
            key: "",
            value: "",
        });
        return copy;
    });
    const deleteIndex = (index: number) => props.modifyElements(list => {
        const copy = [...list];
        copy.splice(index, 1);
        return copy;
    });
    const modifyElement = (index: number, key: string, value: string) => props.modifyElements(list => {
        const copy = [...list];
        copy[index] = { key, value };
        return copy;
    });
    return (
        <div className={classNames(props.className, styles.list, {
            [styles.list_side_by_side]: props.sideBySide,
        })}>
            <div className={styles.list_name}>
                {props.title}
            </div>
            <div className={styles.list_caption}>
                {props.caption}
            </div>
            {!props.readOnly && (
                <IconButton
                    className={styles.add_button}
                    aria-label={props.addButtonLabel}
                    onClick={appendElement}
                    disabled={props.disabled}
                    size={ButtonSize.Small}
                >
                    <PlusIcon />
                </IconButton>
            )}
            <div className={styles.list_elements} role="list">
                {props.elements.map((elem, i) => (
                    <div key={i} className={classNames(styles.element, {
                        [styles.element_side_by_side]: props.sideBySide,
                    })} role="listitem">
                        <TextInput
                            block
                            className={classNames(styles.path, {
                                [styles.path_side_by_side]: props.sideBySide,
                            })}
                            value={elem.key}
                            onChange={(ev: any) => modifyElement(i, ev.target.value, elem.value)}
                            aria-label={`${props.title} name ${i + 1}`}
                            leadingVisual={props.keyIcon}
                            trailingAction={!props.readOnly ? (
                                <TextInputAction
                                    aria-label="Clear input"
                                    aria-labelledby=""
                                    onClick={() => deleteIndex(i)}
                                >
                                    <XIcon />
                                </TextInputAction>
                            ) : undefined}
                            disabled={props.disabled}
                            readOnly={props.readOnly || props.disabled}
                        />
                        {!props.sideBySide && <div className={styles.aliaslink} />}
                        <TextInput
                            block
                            className={classNames(styles.alias, {
                                [styles.alias_side_by_side]: props.sideBySide,
                            })}
                            value={elem.value}
                            onChange={(ev: any) => modifyElement(i, elem.key, ev.target.value)}
                            aria-label={`${props.title} value ${i + 1}`}
                            leadingVisual={props.valueIcon}
                            disabled={props.disabled}
                            readOnly={props.readOnly || props.disabled}
                        />
                        {props.copyValue && props.copyLogContext && (
                            <CopyToClipboardButton
                                className={styles.copy_action}
                                aria-label={`Copy ${props.title} ${i + 1}`}
                                aria-labelledby=""
                                value={props.copyValue(elem)}
                                logContext={props.copyLogContext}
                                variant={ButtonVariant.Invisible}
                                size={ButtonSize.Small}
                            />
                        )}
                    </div>))}
            </div>
        </div>
    );
};

export function flattenKeyValueList(list: KeyValueListElement[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const kv of list) {
        out[kv.key] = kv.value;
    }
    return out;
}
