import * as React from 'react';
import { TextInput, Button } from '@primer/react';
import { CopyIcon, XIcon } from '@primer/octicons-react';

import styles from './keyvalue_list.module.css';

interface Props {
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
    const CopyAction = () => (
        <TextInput.Action
            onClick={() => {
                alert('clear input');
            }}
            icon={CopyIcon}
            aria-label="Clear input"
        />
    );
    const elements: ListElement[] = [{
        key: "foo",
        value: ""
    }];

    return (
        <div className={styles.list}>
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
                            trailingAction={CopyAction()}
                        />
                    </div>))}
            </div>
            <Button
                className={styles.add_button}
            >{listProps.addButtonLabel}</Button>
        </div>
    );
};
