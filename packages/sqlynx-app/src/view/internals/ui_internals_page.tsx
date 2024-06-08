import * as React from 'react';
import * as styles from './ui_internals_page.module.css';

import { ChecklistIcon, CopyIcon, EyeIcon, HeartIcon, TriangleDownIcon } from '@primer/octicons-react';
import { Button as GHButton } from '@primer/react'

import { TextInput, TextInputValidationStatus } from '../base/text_input.js';
import { TextInputAction } from '../base/text_input_action.js';
import { Button } from '../base/button.js';

export function UIInternalsPage(): React.ReactElement {
    return <div className={styles.root}>
        <div className={styles.component_section}>
            <div className={styles.component_section_header}>
                UI Design System
            </div>
            <div className={styles.component}>
                <div className={styles.component_title}>
                    Text Input
                </div>
                <div className={styles.component_variants}>
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
            <div className={styles.component}>
                <div className={styles.component_title}>
                    Button
                </div>
                <div className={styles.component_variants}>
                    <GHButton>Default</GHButton>
                    <GHButton disabled>Default</GHButton>
                    <GHButton variant="primary">Primary</GHButton>
                    <GHButton variant="primary" disabled>Primary</GHButton>
                    <GHButton variant="danger">Danger</GHButton>
                    <GHButton variant="danger" disabled>Danger</GHButton>
                    <GHButton variant="invisible">Invisible</GHButton>
                    <GHButton variant="invisible" disabled>Invisible</GHButton>
                    <GHButton leadingVisual={HeartIcon}>Leading Visual</GHButton>
                    <GHButton trailingVisual={EyeIcon}>Trailing Visual</GHButton>
                    <GHButton count={42}>Counter</GHButton>
                    <GHButton trailingAction={TriangleDownIcon}>Trailing action</GHButton>
                    <GHButton block>Block</GHButton>
                    <GHButton size="small">Small</GHButton>
                    <GHButton size="medium">Medium</GHButton>
                    <GHButton size="large">Large</GHButton>
                    <div className={styles.component_variant_delimiter}></div>
                    <Button>Default</Button>
                </div>
            </div>
        </div>
    </div>;

}