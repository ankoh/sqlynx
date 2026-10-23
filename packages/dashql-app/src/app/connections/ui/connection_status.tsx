import * as React from 'react';
import symbols from '@ankoh/dashql-svg-symbols';

import { ConnectionState } from '../connection_state.js';
import { Button, ButtonVariant } from '../../../ui/foundations/button.js';

interface ButtonProps {
    sessionId?: string;
    conn: ConnectionState;
    onClick?: () => void;
    compact?: boolean;
}

export const CONNECTION_HEALTH_NAMES: string[] = [
    "Disconnected",
    "Connecting",
    "Cancelled",
    "Connected",
    "Failed",
]

export const CONNECTION_HEALTH_COLORS: string[] = [
    "#6e7781",
    "#9a6700",
    "#6e7781",
    "#1f883d",
    "#cf222e",
];

export const ConnectionStatus = React.forwardRef<HTMLButtonElement, ButtonProps>((props, ref) => {
    const health = props.conn.connectionHealth ?? 0;
    const connectorIcon = props.conn.connectorInfo.icons.outlines;

    const connStatusText = props.conn.name ?? props.conn.connectorInfo.names.displayShort;
    const connStatusColor = CONNECTION_HEALTH_COLORS[health];

    const handleClick = () => {
        if (props.onClick) {
            props.onClick();
        }
    };

    // This status button is the small-screen connector affordance, so it uses the outline variant.
    const ConnectorIconVisual = React.useCallback(() => (
        <svg width="16" height="16">
            <use xlinkHref={`${symbols}#${connectorIcon}`} />
        </svg>
    ), [connectorIcon]);
    const StatusDotVisual = React.useCallback(() => (
        <svg width="8" height="8" xmlns="http://www.w3.org/2000/svg">
            <circle cx="4" cy="4" r="4" fill={connStatusColor} />
        </svg>
    ), [connStatusColor]);

    return (
        <Button
            ref={ref}
            variant={ButtonVariant.Default}
            leadingVisual={ConnectorIconVisual}
            trailingVisual={StatusDotVisual}
            onClick={handleClick}
            aria-label={props.compact ? connStatusText : undefined}
        >
            {props.compact ? null : connStatusText}
        </Button>
    );
});
