import * as React from 'react';
import * as styles from './ui_internals_page.module.css';
import { TextInput as GHTextInput } from '@primer/react';
import { TextInput } from '../input/text_input.js';

interface Props {

}

export function UIInternalsPage(props: Props) {
    return <div className={styles.root}>
        <div className={styles.component_section}>
            <div className={styles.component_section_header}>
                UI components
            </div>
            <div className={styles.component}>
                <div className={styles.component_title}>
                    Text Input
                </div>
                <div className={styles.component_description}></div>
                <div className={styles.component_variants}>
                    <GHTextInput />
                    <GHTextInput value="some value" />
                    <GHTextInput placeholder="some placeholder" />
                    <GHTextInput disabled />
                    <GHTextInput disabled placeholder="some placeholder" />
                    <GHTextInput block />
                    <div className={styles.component_variant_delimiter} />
                    <TextInput />
                </div>
            </div>
        </div>
    </div>;

}