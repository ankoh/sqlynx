import * as React from 'react';
import { ThreeBarsIcon } from '../../../ui/foundations/symbol_icon.js';

import type { AttachedDatabaseState } from '../../connections/attached_database_state.js';
import type { ModifySessionScripts } from '../scripts/session_scripts_registry.js';
import type { SessionScripts } from '../scripts/session_scripts.js';
import * as ActionList from '../../../ui/foundations/action_list.js';
import { AnchorAlignment, AnchorSide } from '../../../ui/foundations/anchored_position.js';
import { AnchoredOverlay } from '../../../ui/foundations/anchored_overlay.js';
import { ButtonVariant, IconButton } from '../../../ui/foundations/button.js';
import { OverlaySize } from '../../../ui/foundations/overlay.js';
import { SessionCommandList } from './session_command_lists.js';
import type { SessionFileTreeNavigationLevel } from './session_file_tree.js';

import * as styles from './session_action_menu.module.css';

export interface SessionActionMenuProps {
    conn: AttachedDatabaseState | null;
    sessionScripts: SessionScripts;
    modifySessionScripts: ModifySessionScripts;
    navigationDisabled: boolean;
    navigationLevel: SessionFileTreeNavigationLevel;
    onSelectFolderLevel: () => void;
    onSelectScriptLevel: () => void;
    onSelectPreviousTreeItem: () => void;
    onSelectNextTreeItem: () => void;
    listItem?: boolean;
    triggerClassName?: string;
    triggerRef?: React.Ref<HTMLButtonElement>;
}

export const SessionActionMenu: React.FC<SessionActionMenuProps> = (props) => {
    const [isOpen, setIsOpen] = React.useState(false);
    const triggerRef = React.useRef<HTMLButtonElement | null>(null);

    const open = React.useCallback(() => setIsOpen(true), []);
    const close = React.useCallback(() => setIsOpen(false), []);

    const setTriggerRef = React.useCallback((element: HTMLButtonElement | null) => {
        triggerRef.current = element;
        if (typeof props.triggerRef === 'function') {
            props.triggerRef(element);
        } else if (props.triggerRef) {
            props.triggerRef.current = element;
        }
    }, [props.triggerRef]);
    const side = props.listItem ? AnchorSide.OutsideRight : AnchorSide.OutsideBottom;
    const align = props.listItem ? AnchorAlignment.Start : AnchorAlignment.End;

    return (
        <AnchoredOverlay
            open={isOpen}
            onOpen={open}
            onClose={close}
            renderAnchor={(anchorProps) => props.listItem ? (
                <ActionList.ListItem {...anchorProps} ref={setTriggerRef} aria-label="Open session actions">
                    <ActionList.Leading><span className={styles.leading_spacer} aria-hidden="true" /></ActionList.Leading>
                    <ActionList.ItemText>More</ActionList.ItemText>
                </ActionList.ListItem>
            ) : (
                <IconButton
                    {...anchorProps}
                    ref={setTriggerRef}
                    className={`${styles.trigger} ${props.triggerClassName ?? ''}`.trim()}
                    variant={ButtonVariant.Default}
                    aria-label="Open session actions"
                >
                    <ThreeBarsIcon />
                </IconButton>
            )}
            anchorRef={triggerRef}
            returnFocusRef={triggerRef}
            side={side}
            align={align}
            anchorOffset={8}
            width={OverlaySize.S}
            focusZoneSettings={{ disabled: true }}
            overlayProps={{
                preventFocusOnOpen: false,
            }}
        >
            <div className={styles.overlay} role="dialog" aria-label="Session actions">
                <ActionList.List className={styles.action_list} aria-label="Session actions">
                    <ActionList.GroupHeading>Session</ActionList.GroupHeading>
                    <SessionCommandList
                        conn={props.conn}
                        sessionScripts={props.sessionScripts}
                        modifySessionScripts={props.modifySessionScripts}
                        navigationDisabled={props.navigationDisabled}
                        navigationLevel={props.navigationLevel}
                        onSelectFolderLevel={props.onSelectFolderLevel}
                        onSelectScriptLevel={props.onSelectScriptLevel}
                        onSelectPreviousTreeItem={props.onSelectPreviousTreeItem}
                        onSelectNextTreeItem={props.onSelectNextTreeItem}
                    />
                </ActionList.List>
            </div>
        </AnchoredOverlay>
    );
};
