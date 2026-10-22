import * as React from 'react';
import * as ActionList from '../../../ui/foundations/action_list.js'
import * as styles from './ui_demo.module.css';

import { ChecklistIcon, CopyIcon, EyeIcon, HeartIcon, PaperAirplaneIcon, TriangleDownIcon, ListUnorderedIcon, TableIcon, ProjectIcon, CodeIcon, FileIcon, GraphIcon } from '../../../ui/foundations/symbol_icon.js';

import { TextInput, TextInputValidationStatus } from '../../../ui/foundations/text_input.js';
import { TextInputAction } from '../../../ui/foundations/text_input_action.js';
import { Button, ButtonSize, ButtonVariant } from '../../../ui/foundations/button.js';
import { SegmentedControl, SegmentedControlSize } from '../../../ui/foundations/segmented_control.js';

export function UIExperimentPage(): React.ReactElement {
    const [selectedView, setSelectedView] = React.useState(0);
    const [selectedTab, setSelectedTab] = React.useState(0);

    return <div className={styles.root}>
        <div className={styles.component_section}>
            <div className={styles.component_section_header}>
                UI Design System
            </div>
            <div className={styles.component}>
                <div className={styles.component_title}>
                    Segmented Control
                </div>
                <div className={styles.component_variants}>
                    <SegmentedControl aria-label="View options">
                        <SegmentedControl.Button defaultSelected>List</SegmentedControl.Button>
                        <SegmentedControl.Button>Grid</SegmentedControl.Button>
                        <SegmentedControl.Button>Gallery</SegmentedControl.Button>
                    </SegmentedControl>

                    <SegmentedControl aria-label="View mode" onChange={setSelectedView}>
                        <SegmentedControl.Button selected={selectedView === 0}>Preview</SegmentedControl.Button>
                        <SegmentedControl.Button selected={selectedView === 1}>Code</SegmentedControl.Button>
                        <SegmentedControl.Button selected={selectedView === 2}>Split</SegmentedControl.Button>
                    </SegmentedControl>

                    <SegmentedControl aria-label="File view with icons">
                        <SegmentedControl.Button leadingVisual={ListUnorderedIcon} defaultSelected>
                            List
                        </SegmentedControl.Button>
                        <SegmentedControl.Button leadingVisual={TableIcon}>
                            Table
                        </SegmentedControl.Button>
                        <SegmentedControl.Button leadingVisual={ProjectIcon}>
                            Board
                        </SegmentedControl.Button>
                    </SegmentedControl>

                    <SegmentedControl aria-label="Icon only view">
                        <SegmentedControl.IconButton
                            aria-label="List view"
                            icon={ListUnorderedIcon}
                            defaultSelected
                        />
                        <SegmentedControl.IconButton
                            aria-label="Table view"
                            icon={TableIcon}
                        />
                        <SegmentedControl.IconButton
                            aria-label="Board view"
                            icon={ProjectIcon}
                        />
                        <SegmentedControl.IconButton
                            aria-label="Graph view"
                            icon={GraphIcon}
                        />
                    </SegmentedControl>

                    <SegmentedControl aria-label="With description" onChange={setSelectedTab}>
                        <SegmentedControl.IconButton
                            aria-label="Code"
                            description="View source code"
                            icon={CodeIcon}
                            selected={selectedTab === 0}
                        />
                        <SegmentedControl.IconButton
                            aria-label="Files"
                            description="Browse files"
                            icon={FileIcon}
                            selected={selectedTab === 1}
                        />
                    </SegmentedControl>

                    <SegmentedControl aria-label="Small size" size={SegmentedControlSize.Small}>
                        <SegmentedControl.Button defaultSelected>Small</SegmentedControl.Button>
                        <SegmentedControl.Button>Size</SegmentedControl.Button>
                        <SegmentedControl.Button>Example</SegmentedControl.Button>
                    </SegmentedControl>

                    <SegmentedControl aria-label="With counter">
                        <SegmentedControl.Button count={12} defaultSelected>Open</SegmentedControl.Button>
                        <SegmentedControl.Button count={3}>Closed</SegmentedControl.Button>
                        <SegmentedControl.Button count={45}>All</SegmentedControl.Button>
                    </SegmentedControl>

                    <SegmentedControl aria-label="With disabled">
                        <SegmentedControl.Button defaultSelected>Active</SegmentedControl.Button>
                        <SegmentedControl.Button disabled>Disabled</SegmentedControl.Button>
                        <SegmentedControl.Button>Another</SegmentedControl.Button>
                    </SegmentedControl>

                    <SegmentedControl aria-label="Full width example" fullWidth>
                        <SegmentedControl.Button defaultSelected>Full</SegmentedControl.Button>
                        <SegmentedControl.Button>Width</SegmentedControl.Button>
                        <SegmentedControl.Button>Control</SegmentedControl.Button>
                    </SegmentedControl>
                </div>
            </div>
            <div className={styles.component}>
                <div className={styles.component_title}>
                    Text Input
                </div>
                <div className={styles.component_variants}>
                    <TextInput />
                    <TextInput value="some value" onChange={() => { }} />
                    <TextInput value="looooooooooooooooooooooooooooooooooooooooooong" onChange={() => { }} />
                    <TextInput placeholder="some placeholder" />
                    <TextInput disabled />
                    <TextInput disabled placeholder="some placeholder" />
                    <TextInput validationStatus={TextInputValidationStatus.Success} value="abc" onChange={() => { }} />
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
                                onClick={() => { }}
                                aria-label="action"
                                aria-labelledby=""
                            >
                                <CopyIcon />
                            </TextInputAction>
                        }
                    />
                    <TextInput
                        leadingVisual={ChecklistIcon}
                        trailingVisual={ChecklistIcon}
                        trailingAction={
                            <TextInputAction
                                onClick={() => { }}
                                aria-label="action"
                                aria-labelledby=""
                            >
                                <CopyIcon />
                            </TextInputAction>
                        }
                    />
                </div>
            </div>
            <div className={styles.component}>
                <div className={styles.component_title}>
                    Button
                </div>
                <div className={styles.component_variants}>
                    <Button>Default</Button>
                    <Button disabled>Default</Button>
                    <Button variant={ButtonVariant.Primary}>Primary</Button>
                    <Button variant={ButtonVariant.Primary} disabled>Primary</Button>
                    <Button variant={ButtonVariant.Danger}>Danger</Button>
                    <Button variant={ButtonVariant.Danger} disabled>Danger</Button>
                    <Button variant={ButtonVariant.Invisible}>Invisible</Button>
                    <Button variant={ButtonVariant.Invisible} disabled>Invisible</Button>
                    <Button leadingVisual={HeartIcon}>Leading Visual</Button>
                    <Button trailingVisual={EyeIcon}>Trailing Visual</Button>
                    <Button trailingAction={<TriangleDownIcon />}>Trailing action</Button>
                    <Button block>Block</Button>
                    <Button size={ButtonSize.Small}>Small</Button>
                    <Button size={ButtonSize.Medium}>Medium</Button>
                    <Button size={ButtonSize.Large}>Large</Button>
                </div>
                <div className={styles.component}>
                    <div className={styles.component_title}>
                        Action List
                    </div>
                    <div className={styles.component_variants}>
                        <div className={styles.actionlist_component}>
                            <ActionList.List aria-label="Sessions" leading trailing>
                                <ActionList.GroupHeading>
                                    Sessions
                                </ActionList.GroupHeading>
                                <ActionList.ListItem>
                                    <ActionList.Leading>
                                        <PaperAirplaneIcon />
                                    </ActionList.Leading>
                                    <ActionList.ItemText>
                                        Execute Query
                                    </ActionList.ItemText>
                                    <ActionList.Trailing>
                                        Ctrl + E
                                    </ActionList.Trailing>
                                </ActionList.ListItem>
                                <ActionList.ListItem>
                                    <ActionList.Leading>
                                        <EyeIcon />
                                    </ActionList.Leading>
                                    <ActionList.ItemText>
                                        Execute Query
                                    </ActionList.ItemText>
                                    <ActionList.Trailing>
                                        Ctrl + E
                                    </ActionList.Trailing>
                                </ActionList.ListItem>
                            </ActionList.List>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>;

}
