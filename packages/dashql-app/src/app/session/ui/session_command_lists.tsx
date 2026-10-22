import * as React from 'react';
import symbols from '@ankoh/dashql-svg-symbols';
import * as ActionList from '../../../ui/foundations/action_list.js';
import { LinkIcon, PaperAirplaneIcon, SyncIcon } from '../../../ui/foundations/symbol_icon.js';

import { DASHQL_ARCHIVE_FILENAME_EXT } from '../../../globals.js';
import { SessionCommandType, useSessionCommandDispatch } from '../scripts/session_commands.js';
import type { ModifySessionScripts } from '../scripts/session_scripts_registry.js';
import { SessionScripts } from '../scripts/session_scripts.js';
import { SymbolIcon } from '../../../ui/foundations/symbol_icon.js';
import { SessionFileSaveOverlay } from './session_file_save_overlay.js';
import { SessionURLShareOverlay } from './session_url_share_overlay.js';
import { ConnectionHealth, AttachedDatabaseState } from '../connections/attached_database_state.js';
import { CONNECTION_HEALTH_COLORS } from '../connections/ui/connection_status.js';
import { isCatalogRefreshRunning } from '../connections/catalog_update_state.js';
import { IndicatorStatus, StatusIndicator } from '../../../ui/foundations/status_indicator.js';
import type { SessionFileTreeNavigationLevel } from './session_file_tree.js';
import { getHyperConnectionDetails } from '../connections/hyper/hyper_connection_state.js';
import { useAppFlavor } from '../../flavor/flavor_provider.js';

export interface ConnectionCommandListDependencies {
    StatusIndicator: typeof StatusIndicator;
    useSessionCommandDispatch: typeof useSessionCommandDispatch;
}

const DEFAULT_CONNECTION_COMMAND_LIST_DEPENDENCIES: ConnectionCommandListDependencies = {
    StatusIndicator,
    useSessionCommandDispatch,
};

export const ConnectionCommandList: React.FC<{
    conn: AttachedDatabaseState | null;
    sessionScripts: SessionScripts | null;
    navigationDisabled?: boolean;
    onOpenSettings?: () => void;
    settingsRef?: React.Ref<HTMLButtonElement>;
    dependencies?: ConnectionCommandListDependencies;
}> = (props) => {
    const dependencies = props.dependencies ?? DEFAULT_CONNECTION_COMMAND_LIST_DEPENDENCIES;
    const sessionCommand = dependencies.useSessionCommandDispatch();
    const StatusIndicatorComponent = dependencies.StatusIndicator;

    const isDisconnected = props.conn?.connectionHealth !== ConnectionHealth.ONLINE;

    const connectorIcon = props.conn?.connectorInfo.icons.outlines;
    const health = props.conn?.connectionHealth ?? 0;
    const statusColor = CONNECTION_HEALTH_COLORS[health];
    const isEmbedded = props.conn?.details != null &&
        getHyperConnectionDetails(props.conn)?.proto.setupParams?.protocol === 'WASM';
    const showHealthCheck = (props.conn?.connectorInfo.features.healthChecks ?? false) && !isEmbedded;
    const isRefreshing = isCatalogRefreshRunning(props.conn);
    return (
        <>
            <ActionList.ListItem
                ref={props.settingsRef}
                onClick={props.onOpenSettings}
            >
                <ActionList.Leading>
                    <svg width="16" height="16">
                        <use xlinkHref={`${symbols}#${connectorIcon}`} />
                    </svg>
                </ActionList.Leading>
                <ActionList.ItemText>
                    Edit Attached Database
                </ActionList.ItemText>
                {showHealthCheck ? (
                    <ActionList.Trailing>
                        <svg width="8" height="8" xmlns="http://www.w3.org/2000/svg">
                            <circle cx="4" cy="4" r="4" fill={statusColor} />
                        </svg>
                    </ActionList.Trailing>
                ) : <></>}
            </ActionList.ListItem>
            <ActionList.ListItem
                disabled={props.navigationDisabled || isDisconnected || !props.conn?.connectorInfo.features.executeQueryAction}
                onClick={() => sessionCommand(SessionCommandType.ExecuteEditorQuery)}
            >
                <ActionList.Leading>
                    <PaperAirplaneIcon />
                </ActionList.Leading>
                <ActionList.ItemText>
                    Execute Script
                </ActionList.ItemText>
                <ActionList.Trailing>Ctrl + E</ActionList.Trailing>
            </ActionList.ListItem>
            <ActionList.ListItem
                disabled={isDisconnected || isRefreshing || !props.conn?.connectorInfo.features.refreshSchemaAction}
                aria-busy={isRefreshing}
                onClick={() => sessionCommand(SessionCommandType.RefreshCatalog)}
            >
                <ActionList.Leading>
                    {isRefreshing
                        ? <StatusIndicatorComponent status={IndicatorStatus.Running} width="16px" height="16px" />
                        : <SyncIcon />}
                </ActionList.Leading>
                <ActionList.ItemText>
                    Refresh Catalog
                </ActionList.ItemText>
                <ActionList.Trailing>Ctrl + R</ActionList.Trailing>
            </ActionList.ListItem>
        </>
    );
};

export const SessionCommandList: React.FC<{
    conn: AttachedDatabaseState | null;
    sessionScripts: SessionScripts | null;
    modifySessionScripts: ModifySessionScripts | null;
    navigationDisabled?: boolean;
    navigationLevel: SessionFileTreeNavigationLevel;
    onSelectFolderLevel: () => void;
    onSelectScriptLevel: () => void;
    onSelectPreviousTreeItem: () => void;
    onSelectNextTreeItem: () => void;
}> = (props) => {
    const [linkSharingIsOpen, openLinkSharing] = React.useState<boolean>(false);
    const [fileSaveIsOpen, openFileSave] = React.useState<boolean>(false);
    const archiveExport = useAppFlavor().features.sessionArchiveExport;
    const ArrowDownIcon = SymbolIcon('arrow_down_16');
    const ArrowUpIcon = SymbolIcon('arrow_up_16');
    const ArrowLeftIcon = SymbolIcon('arrow_left_16');
    const ArrowRightIcon = SymbolIcon('arrow_right_16');
    const FileZipIcon = SymbolIcon('file_zip_16');

    return (
        <>
            <ActionList.ListItem
                onClick={props.onSelectFolderLevel}
                disabled={props.navigationDisabled || props.navigationLevel === 'folders'}
            >
                <ActionList.Leading>
                    <ArrowLeftIcon />
                </ActionList.Leading>
                <ActionList.ItemText>
                    Folder Level
                </ActionList.ItemText>
                <ActionList.Trailing>Ctrl + H</ActionList.Trailing>
            </ActionList.ListItem>
            <ActionList.ListItem
                onClick={props.onSelectScriptLevel}
                disabled={props.navigationDisabled || props.navigationLevel === 'scripts'}
            >
                <ActionList.Leading>
                    <ArrowRightIcon />
                </ActionList.Leading>
                <ActionList.ItemText>
                    Script Level
                </ActionList.ItemText>
                <ActionList.Trailing>Ctrl + L</ActionList.Trailing>
            </ActionList.ListItem>
            <ActionList.ListItem
                onClick={props.onSelectPreviousTreeItem}
                disabled={props.navigationDisabled || props.sessionScripts == null}
            >
                <ActionList.Leading>
                    <ArrowUpIcon />
                </ActionList.Leading>
                <ActionList.ItemText>
                    Previous {props.navigationLevel === 'folders' ? 'Folder' : 'Script'}
                </ActionList.ItemText>
                <ActionList.Trailing>Ctrl + K</ActionList.Trailing>
            </ActionList.ListItem>
            <ActionList.ListItem
                onClick={props.onSelectNextTreeItem}
                disabled={props.navigationDisabled || props.sessionScripts == null}
            >
                <ActionList.Leading>
                    <ArrowDownIcon />
                </ActionList.Leading>
                <ActionList.ItemText>
                    Next {props.navigationLevel === 'folders' ? 'Folder' : 'Script'}
                </ActionList.ItemText>
                <ActionList.Trailing>Ctrl + J</ActionList.Trailing>
            </ActionList.ListItem>
            <ActionList.ListItem onClick={() => openLinkSharing(s => !s)}>
                <ActionList.Leading>
                    <LinkIcon />
                </ActionList.Leading>
                <ActionList.ItemText>
                    Share as URL
                    <SessionURLShareOverlay isOpen={linkSharingIsOpen} setIsOpen={openLinkSharing} />
                </ActionList.ItemText>
            </ActionList.ListItem>
            {archiveExport && (
                <ActionList.ListItem onClick={() => openFileSave(s => !s)}>
                    <ActionList.Leading>
                        <FileZipIcon />
                    </ActionList.Leading>
                    <ActionList.ItemText>
                        Save .{DASHQL_ARCHIVE_FILENAME_EXT}
                        <SessionFileSaveOverlay
                            isOpen={fileSaveIsOpen}
                            setIsOpen={openFileSave}
                            conn={props.conn}
                            sessionScripts={props.sessionScripts}
                        />
                    </ActionList.ItemText>
                    <ActionList.Trailing>Ctrl + S</ActionList.Trailing>
                </ActionList.ListItem>
            )}
        </>
    );
};
