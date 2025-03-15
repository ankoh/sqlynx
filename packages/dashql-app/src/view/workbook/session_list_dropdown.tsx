import * as React from 'react';
import * as ActionList from '../foundations/action_list.js';

import { useCurrentWorkbookSelector, useCurrentWorkbookState } from '../../workbook/current_workbook.js';
import { useWorkbookRegistry } from '../../workbook/workbook_state_registry.js';
import { AnchoredOverlay } from '../foundations/anchored_overlay.js';
import { Button, ButtonVariant } from '../foundations/button.js';
import { ConnectorIcon, ConnectorIconVariant } from '../connection/connection_icons.js';
import {
    HYPER_GRPC_CONNECTOR,
    SALESFORCE_DATA_CLOUD_CONNECTOR,
    SERVERLESS_CONNECTOR,
    DEMO_CONNECTOR,
    TRINO_CONNECTOR,
} from '../../connection/connector_info.js';
import { WorkbookState } from '../../workbook/workbook_state.js';
import { useConnectionRegistry } from '../../connection/connection_registry.js';
import { ConnectionHealth } from '../../connection/connection_state.js';

export function WorkbookListDropdown(props: { className?: string; short: boolean }) {
    const workbookRegistry = useWorkbookRegistry();
    const [workbookState, _modifyWorkbookState] = useCurrentWorkbookState();
    const selectWorkbook = useCurrentWorkbookSelector();
    const [isOpen, setIsOpen] = React.useState<boolean>(false);
    const connRegistry = useConnectionRegistry();

    const onWorkbookClick = React.useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        const target = e.currentTarget as HTMLLIElement;
        if (target.dataset.item) {
            const workbookId = Number.parseInt(target.dataset.item)!;
            selectWorkbook(workbookId);
        } else {
            console.warn("click target did not contain a data attribute");
        }
    }, []);
    const connectorName = !workbookState?.connectorInfo
        ? 'Not set'
        : props.short
            ? workbookState?.connectorInfo.displayName.short
            : workbookState?.connectorInfo.displayName.long;

    // Memoize button to prevent svg flickering
    const button = React.useMemo(() => (
        <Button
            className={props.className}
            onClick={() => setIsOpen(true)}
            variant={ButtonVariant.Invisible}
            leadingVisual={() => (!workbookState?.connectorInfo
                ? <div />
                : <ConnectorIcon connector={workbookState?.connectorInfo} variant={ConnectorIconVariant.OUTLINES} />
            )}
        >
            {connectorName}
        </Button>
    ), [workbookState?.connectorInfo, connectorName]);

    const renderItem = ([workbookId, workbook]: [number, WorkbookState]) => {
        const connection = connRegistry.connectionMap.get(workbook.connectionId)!;
        let description: React.ReactElement | undefined = undefined;
        let enabled: boolean = true;

        switch (connection.details.type) {
            case SALESFORCE_DATA_CLOUD_CONNECTOR: {
                enabled = connection.connectionHealth === ConnectionHealth.ONLINE;
                if (enabled) {
                    const dcTenant = connection.details.value.dataCloudAccessToken?.dcTenantId;
                    description = (
                        <ActionList.ItemTextDescription>
                            {dcTenant ? dcTenant : "-"}
                        </ActionList.ItemTextDescription>
                    );
                } else {
                    description = (
                        <ActionList.ItemTextDescription>
                            Not connected
                        </ActionList.ItemTextDescription>
                    );
                }
                break;
            }
            case HYPER_GRPC_CONNECTOR: {
                enabled = connection.connectionHealth === ConnectionHealth.ONLINE;
                if (enabled) {
                    const endpoint = connection.details.value.channelSetupParams?.channelArgs.endpoint;
                    description = (
                        <ActionList.ItemTextDescription>
                            {endpoint ? endpoint : "-"}
                        </ActionList.ItemTextDescription>
                    );
                } else {
                    description = (
                        <ActionList.ItemTextDescription>
                            Not connected
                        </ActionList.ItemTextDescription>
                    );
                }
                break;
            }
            case TRINO_CONNECTOR: {
                enabled = connection.connectionHealth === ConnectionHealth.ONLINE;
                if (enabled) {
                    const endpoint = connection.details.value.channelParams?.channelArgs.endpoint;
                    description = (
                        <ActionList.ItemTextDescription>
                            {endpoint ? endpoint : "-"}
                        </ActionList.ItemTextDescription>
                    );
                } else {
                    description = (
                        <ActionList.ItemTextDescription>
                            Not connected
                        </ActionList.ItemTextDescription>
                    );
                }
                break;
            }
            case SERVERLESS_CONNECTOR:
            case DEMO_CONNECTOR:
                break;
        }
        return (
            <ActionList.ListItem
                key={workbookId}
                data-workbook={workbook.connectionId}
                onClick={onWorkbookClick}
                selected={workbookId === workbookState?.workbookId}
                disabled={!enabled}
                data-item={workbookId.toString()}
            >
                <ActionList.Leading>
                    <ConnectorIcon connector={workbook.connectorInfo} variant={ConnectorIconVariant.OUTLINES} />
                </ActionList.Leading>
                <ActionList.ItemText>
                    <ActionList.ItemTextTitle>
                        {props.short ? workbook.connectorInfo.displayName.short : workbook.connectorInfo.displayName.long}
                    </ActionList.ItemTextTitle>
                    {description}
                </ActionList.ItemText>
            </ActionList.ListItem>
        )
    };

    const workbooks = React.useMemo(() => [...workbookRegistry.workbookMap.entries()].sort((l, r) => {
        return l[1].connectorInfo.connectorType - r[1].connectorInfo.connectorType;
    }), [workbookRegistry]);

    return (
        <AnchoredOverlay
            open={isOpen}
            onClose={() => setIsOpen(false)}
            renderAnchor={(p: object) => <div {...p}>{button}</div>}
        >
            <ActionList.List aria-label="Workbooks">
                <ActionList.GroupHeading>Workbooks</ActionList.GroupHeading>
                <>
                    {workbooks.map(renderItem)}
                </>
            </ActionList.List>
        </AnchoredOverlay>
    );
}
