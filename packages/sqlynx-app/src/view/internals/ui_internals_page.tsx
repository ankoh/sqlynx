import * as React from 'react';
import * as styles from './ui_internals_page.module.css';

import { TextInput as GHTextInput } from '@primer/react';
import { ChecklistIcon, CopyIcon } from '@primer/octicons-react';

import { TextInput, TextInputValidationStatus } from '../base/text_input.js';
import { CopyToClipboardAction } from '../../utils/clipboard.js';
import { TextInputAction } from '../base/text_input_action.js';

interface Props {

}

export function UIInternalsPage(props: Props) {
    return <div className={styles.root}>
        <div className={styles.component_section}>
            <div className={styles.component_section_header}>
                UI Design System
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
                    <GHTextInput
                        leadingVisual={() => <div>URL</div>}
                    />
                    <GHTextInput
                        leadingVisual={ChecklistIcon}
                    />
                    <GHTextInput
                        trailingVisual={ChecklistIcon}
                    />
                    <GHTextInput
                        leadingVisual={ChecklistIcon}
                        trailingVisual={ChecklistIcon}
                    />
                    <GHTextInput
                        trailingAction={<CopyToClipboardAction value="foo" logContext="bar" ariaLabel={`Copy foo`} />}
                    />
                    <GHTextInput
                        leadingVisual={ChecklistIcon}
                        trailingVisual={ChecklistIcon}
                        trailingAction={<CopyToClipboardAction value="foo" logContext="bar" ariaLabel={`Copy foo`} />}
                    />

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
                    <TextInput
                        leadingVisual={() => <div>URL</div>}
                    />
                    <TextInput
                        leadingVisual={ChecklistIcon}
                    />
                    <TextInput
                        trailingVisual={ChecklistIcon}
                    />
                    <TextInput
                        leadingVisual={ChecklistIcon}
                        trailingVisual={ChecklistIcon}
                    />
                    <TextInput
                        trailingAction={
                            <TextInputAction
                                onClick={() => {}}
                                icon={CopyIcon}
                                aria-label="action"
                                aria-labelledby=""
                            />
                        }
                    />
                    <TextInput
                        leadingVisual={ChecklistIcon}
                        trailingVisual={ChecklistIcon}
                        trailingAction={
                            <TextInputAction
                                onClick={() => {}}
                                icon={CopyIcon}
                                aria-label="action"
                                aria-labelledby=""
                            />
                        }
                    />
                </div>
            </div>
        </div>
    </div>;

}