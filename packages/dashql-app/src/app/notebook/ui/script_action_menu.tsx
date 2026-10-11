import * as React from 'react';
import * as dashql from '@ankoh/dashql-core';
import * as styles from './action_menu.module.css';

import { ButtonSize, ButtonVariant, IconButton } from '../../../ui/foundations/button.js';
import * as ActionList from '../../../ui/foundations/action_list.js';
import { AnchorAlignment, AnchorSide } from '../../../ui/foundations/anchored_position.js';
import { AnchoredOverlay } from '../../../ui/foundations/anchored_overlay.js';
import { SymbolIcon } from '../../../ui/foundations/symbol_icon.js';

interface Props {
    scriptName: string;
    formatDisabled: boolean;
    deleteDisabled: boolean;
    onFormat: (mode: dashql.buffers.formatting.FormattingMode) => void;
    onDelete: () => void;
}

const MoreIcon = SymbolIcon('kebab_horizontal');
const FormatIcon = SymbolIcon('pencil_ai_16');
const TrashIcon = SymbolIcon('trash_16');

export const ScriptActionMenu: React.FC<Props> = (props) => {
    const [open, setOpen] = React.useState(false);
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const run = React.useCallback((action: () => void) => {
        setOpen(false);
        action();
    }, []);

    return (
        <AnchoredOverlay
            open={open}
            onOpen={() => setOpen(true)}
            onClose={() => setOpen(false)}
            side={AnchorSide.OutsideBottom}
            align={AnchorAlignment.End}
            anchorOffset={4}
            anchorRef={triggerRef}
            returnFocusRef={triggerRef}
            renderAnchor={(anchorProps) => (
                <IconButton
                    {...anchorProps}
                    ref={triggerRef}
                    variant={ButtonVariant.Invisible}
                    size={ButtonSize.Small}
                    aria-label={`More actions for ${props.scriptName} script`}
                >
                    <MoreIcon size={16} />
                </IconButton>
            )}
        >
            <div className={styles.menu} role="dialog" aria-label={`Actions for ${props.scriptName} script`}>
                <ActionList.List aria-label={`Actions for ${props.scriptName} script`}>
                    <ActionList.ListItem
                        disabled={props.formatDisabled}
                        onClick={() => run(() => props.onFormat(dashql.buffers.formatting.FormattingMode.PRETTY))}
                    >
                        <ActionList.Leading><FormatIcon size={16} /></ActionList.Leading>
                        <ActionList.ItemText>Format Pretty</ActionList.ItemText>
                    </ActionList.ListItem>
                    <ActionList.ListItem
                        disabled={props.formatDisabled}
                        onClick={() => run(() => props.onFormat(dashql.buffers.formatting.FormattingMode.COMPACT))}
                    >
                        <ActionList.Leading><FormatIcon size={16} /></ActionList.Leading>
                        <ActionList.ItemText>Format Compact</ActionList.ItemText>
                    </ActionList.ListItem>
                    <ActionList.ListItem
                        className={styles.delete_action}
                        disabled={props.deleteDisabled}
                        onClick={() => run(props.onDelete)}
                    >
                        <ActionList.Leading><TrashIcon size={16} /></ActionList.Leading>
                        <ActionList.ItemText>Delete</ActionList.ItemText>
                    </ActionList.ListItem>
                </ActionList.List>
            </div>
        </AnchoredOverlay>
    );
};
