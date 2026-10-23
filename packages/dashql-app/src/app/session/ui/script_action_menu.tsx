import * as React from 'react';
import * as dashql from '@ankoh/dashql-core';
import * as styles from '../../ui/action_menu.module.css';

import { ButtonSize, ButtonVariant, IconButton } from '../../../ui/foundations/button.js';
import * as ActionList from '../../../ui/foundations/action_list.js';
import { AnchorAlignment, AnchorSide } from '../../../ui/foundations/anchored_position.js';
import { AnchoredOverlay } from '../../../ui/foundations/anchored_overlay.js';
import { SymbolIcon } from '../../../ui/foundations/symbol_icon.js';

/// Where a script is stored
export interface ScriptStorage {
    /// The file name of the script, e.g. "01_extract.sql"
    fileName: string;
    /// The full path of the script file, resolved when the storage view opens
    resolvePath: () => string;
    /// Rename the script file
    onRename: (name: string) => void;
}

interface Props {
    scriptName: string;
    formatDisabled: boolean;
    onFormat: (mode: dashql.buffers.formatting.FormattingMode) => void;
    onDelete: () => void;
    /// The storage of the script, the menu offers its storage view
    storage?: ScriptStorage;
}

const MoreIcon = SymbolIcon('kebab_horizontal');
const FormatIcon = SymbolIcon('pencil_ai_16');
const TrashIcon = SymbolIcon('trash_16');
const StorageIcon = SymbolIcon('file_directory_16');
const CloseIcon = SymbolIcon('x_16');

export const ScriptActionMenu: React.FC<Props> = (props) => {
    const [open, setOpen] = React.useState(false);
    // The menu switches to the storage view in place
    const [view, setView] = React.useState<'actions' | 'storage'>('actions');
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const run = React.useCallback((action: () => void) => {
        setOpen(false);
        action();
    }, []);

    return (
        <AnchoredOverlay
            open={open}
            onOpen={() => { setView('actions'); setOpen(true); }}
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
            {view === 'storage' && props.storage != null ? (
                <ScriptStorageView scriptName={props.scriptName} storage={props.storage} onClose={() => setOpen(false)} />
            ) : (
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
                    {/* The list takes elements only, the fragment wraps the optional item */}
                    <>{props.storage != null && (
                        <ActionList.ListItem onClick={() => setView('storage')}>
                            <ActionList.Leading><StorageIcon size={16} /></ActionList.Leading>
                            <ActionList.ItemText>Storage</ActionList.ItemText>
                        </ActionList.ListItem>
                    )}</>
                    <ActionList.ListItem
                        className={styles.delete_action}
                        onClick={() => run(props.onDelete)}
                    >
                        <ActionList.Leading><TrashIcon size={16} /></ActionList.Leading>
                        <ActionList.ItemText>Delete</ActionList.ItemText>
                    </ActionList.ListItem>
                </ActionList.List>
            </div>
            )}
        </AnchoredOverlay>
    );
};

/// Where a script is stored, the file name can be edited
function ScriptStorageView(props: { scriptName: string; storage: ScriptStorage; onClose: () => void }) {
    const path = React.useMemo(() => props.storage.resolvePath(), [props.storage]);
    const inputRef = React.useRef<HTMLInputElement>(null);
    const cancelRef = React.useRef(false);
    React.useEffect(() => {
        if (inputRef.current != null) inputRef.current.value = props.storage.fileName;
    }, [props.storage.fileName]);
    const commit = (event: React.FocusEvent<HTMLInputElement>) => {
        if (cancelRef.current) {
            cancelRef.current = false;
            return;
        }
        const name = event.currentTarget.value.trim();
        if (name && name !== props.storage.fileName) props.storage.onRename(name);
    };
    const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
            event.currentTarget.blur();
        } else if (event.key === 'Escape') {
            // Abandon the edit
            cancelRef.current = true;
            event.currentTarget.value = props.storage.fileName;
            event.currentTarget.blur();
        }
        event.stopPropagation();
    };
    return (
        <div className={styles.storage} role="dialog" aria-label={`Storage of ${props.scriptName} script`}>
            <div className={styles.storage_header}>
                <span className={styles.storage_title}>Script Storage</span>
                <IconButton variant={ButtonVariant.Invisible} size={ButtonSize.Small} aria-label="Close script storage" onClick={props.onClose}>
                    <CloseIcon size={16} />
                </IconButton>
            </div>
            <div className={styles.storage_body}>
                <label className={styles.storage_label} htmlFor={`script-file-${props.storage.fileName}`}>File</label>
                <input
                    id={`script-file-${props.storage.fileName}`}
                    ref={inputRef}
                    className={styles.storage_input}
                    type="text"
                    aria-label="Script file name"
                    defaultValue={props.storage.fileName}
                    spellCheck={false}
                    onBlur={commit}
                    onKeyDown={onKeyDown}
                    onPointerDown={event => event.stopPropagation()}
                />
                <span className={styles.storage_label}>Path</span>
                <span className={styles.storage_path} title={path}>{path}</span>
            </div>
        </div>
    );
}
