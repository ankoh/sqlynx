import * as React from 'react';
import { TextInput, Button, IconButton } from '@primer/react';
import { CopyIcon, PlusIcon, XIcon } from '@primer/octicons-react';
import { classNames } from '../utils/classnames.js';

import * as styles from './keyvalue_list.module.css';

interface Props {
    className?: string;
    title: string;
    caption: string;
    keyIcon: React.ElementType;
    valueIcon: React.ElementType;
    addButtonLabel: string;
}

interface ListElement {
    key: string;
    value: string;
}

export const KeyValueListBuilder: React.FC<Props> = (
    listProps: Props,
) => {
    const elements: ListElement[] = [{
        key: "x-hyperdb-workload",
        value: "foo"
    }, {
        key: "foo",
        value: "bar"
    }];

    return (
        <div className={classNames(listProps.className, styles.list)}>
            <div className={styles.list_name}>
                {listProps.title}
            </div>
            <div className={styles.list_caption}>
                {listProps.caption}
            </div>
            <IconButton className={styles.add_button} icon={PlusIcon} aria-label="add-entry" />
            <div className={styles.list_elements}>
                {elements.map((props, i) => (
                    <div key={i} className={styles.element}>
                        <TextInput
                            block
                            className={styles.path}
                            value={props.key}
                            onChange={() => { }}
                            leadingVisual={listProps.keyIcon}
                            trailingAction={
                                <TextInput.Action
                                    onClick={() => {
                                        alert('clear input')
                                    }}
                                    icon={XIcon}
                                    sx={{ color: 'fg.subtle' }}
                                    aria-label="Clear input"
                                />
                            }
                        />
                        <div className={styles.aliaslink} />
                        <TextInput
                            block
                            className={styles.alias}
                            value={props.value}
                            onChange={() => { }}
                            placeholder="Database Alias"
                            leadingVisual={listProps.valueIcon}
                        />
                    </div>))}
            </div>
        </div>
    );
};
