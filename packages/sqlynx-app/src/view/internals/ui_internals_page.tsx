import * as React from 'react';
import * as styles from './ui_internals_page.module.css';
import { TextInput as GHTextInput } from '@primer/react';
import { TextInput, TextInputValidationStatus } from '../input/text_input.js';

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
                    <GHTextInput value="some value" onChange={() => {}} />
                    <GHTextInput value="looooooooooooooooooooooooooooooooooooooooooong"  onChange={() => {}}/>
                    <GHTextInput placeholder="some placeholder" />
                    <GHTextInput disabled />
                    <GHTextInput disabled placeholder="some placeholder" />
                    <GHTextInput validationStatus="success" value="abc" onChange={() => {}} />
                    <GHTextInput validationStatus="error" />
                    <GHTextInput block />
                    <div className={styles.component_variant_delimiter} />
                    <TextInput />
                    <TextInput value="some value" onChange={() => {}} />
                    <TextInput value="looooooooooooooooooooooooooooooooooooooooooong" onChange={() => {}} />
                    <TextInput placeholder="some placeholder" />
                    <TextInput disabled />
                    <TextInput disabled placeholder="some placeholder" />
                    <TextInput validationStatus={TextInputValidationStatus.Success} value="abc" onChange={() => {}} />
                    <TextInput validationStatus={TextInputValidationStatus.Error} />
                    <TextInput block />
                </div>
            </div>
        </div>
    </div>;

}