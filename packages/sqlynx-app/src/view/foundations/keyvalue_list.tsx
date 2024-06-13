import * as React from 'react';
import * as Immutable from 'immutable';

import { Dispatch } from '../../utils/variant.js';
import { PlusIcon, XIcon } from '@primer/octicons-react';
import { classNames } from '../../utils/classnames.js';

import * as styles from './keyvalue_list.module.css';
import { TextInput } from './text_input.js';
import { IconButton } from '@primer/react';
import { TextInputAction } from './text_input_action.js';

export interface KeyValueListElement {
    index: number;
    key: string;
    value: string;
}

export type UpdateKeyValueList = (prev: Immutable.List<KeyValueListElement>) => Immutable.List<KeyValueListElement>;

interface Props {
    className?: string;
    title: string;
    caption: string;
    keyIcon: React.ElementType;
    valueIcon: React.ElementType;
    addButtonLabel: string;
    elements: Immutable.List<KeyValueListElement>;
    modifyElements: Dispatch<UpdateKeyValueList>;
    disabled?: boolean;
    readOnly?: boolean;
}

export const KeyValueListBuilder: React.FC<Props> = (props: Props) => {
    const appendElement = () => props.modifyElements(list => list.push({
        index: list.size,
        key: "",
        value: "",
    }));
    const deleteIndex = (index: number) => props.modifyElements(list => list.delete(index));
    const modifyElement = (index: number, key: string, value: string) => props.modifyElements(list => list.set(index, {
        index: index,
        key,
        value,
    }));

    return (
        <div className={classNames(props.className, styles.list)}>
            <div className={styles.list_name}>
                {props.title}
            </div>
            <div className={styles.list_caption}>
                {props.caption}
            </div>
            <IconButton
                className={styles.add_button}
                icon={PlusIcon}
                aria-label="add-entry"
                onClick={appendElement}
                disabled={props.disabled}
            />
            <div className={styles.list_elements}>
                {props.elements.map((elem, i) => (
                    <div key={i} className={styles.element}>
                        <TextInput
                            block
                            className={styles.path}
                            value={elem.key}
                            onChange={(ev: any) => modifyElement(i, ev.target.value, elem.value)}
                            leadingVisual={props.keyIcon}
                            trailingAction={
                                <TextInputAction
                                    icon={XIcon}
                                    aria-label="Clear input"
                                    aria-labelledby=""
                                    onClick={() => deleteIndex(i)}
                                />
                            }
                            disabled={props.disabled}
                            readOnly={props.disabled}
                        />
                        <div className={styles.aliaslink} />
                        <TextInput
                            block
                            className={styles.alias}
                            value={elem.value}
                            onChange={(ev: any) => modifyElement(i, elem.key, ev.target.value)}
                            placeholder="Database Alias"
                            leadingVisual={props.valueIcon}
                            disabled={props.disabled}
                            readOnly={props.disabled}
                        />
                    </div>))}
            </div>
        </div>
    );
};
