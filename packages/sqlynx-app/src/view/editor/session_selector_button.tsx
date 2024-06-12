import * as React from 'react';
import * as ActionList from '../base/action_list.js';

import { useCurrentSessionState } from '../../session/current_session.js';
import { useSessionStates } from '../../session/session_state_registry.js';
import { AnchoredOverlay } from '../base/anchored_overlay.js';
import { Button, ButtonVariant } from '../base/button.js';
import { ConnectorIcon, ConnectorIconVariant } from '../connectors/connector_icons.js';
import {
    HYPER_GRPC_CONNECTOR,
    SALESFORCE_DATA_CLOUD_CONNECTOR,
    SERVERLESS_CONNECTOR,
} from '../../connectors/connector_info.js';
import { SessionState } from '../../session/session_state.js';
import { useConnectionRegistry } from '../../connectors/connection_registry.js';
import { ConnectionHealth } from '../../connectors/connection_status.js';

export function SessionSelectorButton(props: { className?: string; short: boolean }) {
    const sessionRegistry = useSessionStates();
    const [sessionState, _modifySessionState] = useCurrentSessionState();
    const [isOpen, setIsOpen] = React.useState<boolean>(false);
    const connRegistry = useConnectionRegistry();

    const selectConnector = React.useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        // const target = e.currentTarget as HTMLLIElement;
        // const connectorType = Number.parseInt(target.dataset.connector ?? '0')! as ConnectorType;
        // setIsOpen(false);
        // scriptStateDispatch({
        //     type: SELECT_CONNECTOR,
        //     value: connectorType,
        // });
    }, []);
    const connectorName = !sessionState?.connectorInfo
        ? 'Not set'
        : props.short
            ? sessionState?.connectorInfo.displayName.short
            : sessionState?.connectorInfo.displayName.long;

    // Memoize button to prevent svg flickering
    const button = React.useMemo(() => (
        <Button
            className={props.className}
            onClick={() => setIsOpen(true)}
            variant={ButtonVariant.Invisible}
            leadingVisual={() => (!sessionState?.connectorInfo
                    ? <div />
                    : <ConnectorIcon connector={sessionState?.connectorInfo} variant={ConnectorIconVariant.UNCOLORED} />
            )}
        >
            {connectorName}
        </Button>
    ), [sessionState?.connectorInfo, connectorName]);

    const renderItem = ([sessionId, session]: [number, SessionState]) => {
        const connection = connRegistry.get(session.connectionId);
        let description: React.ReactElement | undefined = undefined;
        let enabled: boolean = true;

        switch (connection!.type) {
            case SALESFORCE_DATA_CLOUD_CONNECTOR: {
                enabled = connection!.value.connectionHealth === ConnectionHealth.ONLINE;
                if (enabled) {
                    const dcTenant = connection!.value.dataCloudAccessToken?.dcTenantId;
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
                enabled = connection!.value.connectionHealth === ConnectionHealth.ONLINE;
                if (enabled) {
                    const endpoint = connection!.value.channelSetupParams?.channel.endpoint;
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
                break;
        }
        return (
            <ActionList.ListItem
                key={sessionId}
                data-session={session.connectionId}
                onClick={selectConnector}
                selected={sessionId === sessionState?.sessionId}
                disabled={!enabled}
            >
                <ActionList.Leading>
                    <ConnectorIcon connector={session.connectorInfo} variant={ConnectorIconVariant.OUTLINES} />
                </ActionList.Leading>
                <ActionList.ItemText>
                    <ActionList.ItemTextTitle>
                        {props.short ? session.connectorInfo.displayName.short : session.connectorInfo.displayName.long}
                    </ActionList.ItemTextTitle>
                    {description}
                </ActionList.ItemText>
            </ActionList.ListItem>
        )
    };

    const sessions = React.useMemo(() => [...sessionRegistry.entries()].sort((l, r) => {
        return l[1].connectorInfo.connectorType - r[1].connectorInfo.connectorType;
    }), [sessionRegistry]);

    return (
        <AnchoredOverlay
            open={isOpen}
            onClose={() => setIsOpen(false)}
            renderAnchor={(p: object) => <div {...p}>{button}</div>}
        >
            <ActionList.List aria-label="Sessions">
                <ActionList.GroupHeading>Sessions</ActionList.GroupHeading>
                <>
                    {sessions.map(renderItem)}
                </>
            </ActionList.List>
        </AnchoredOverlay>
    );
}
