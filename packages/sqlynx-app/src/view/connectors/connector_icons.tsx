import * as React from 'react';

import { ConnectorInfo } from '../../connectors/connector_info.js';

import * as icons from '../../../static/svg/symbols.generated.svg';

export enum ConnectorIconVariant {
    COLORED,
    UNCOLORED,
    OUTLINES
}

interface Props {
    connector: ConnectorInfo;
    variant: ConnectorIconVariant;
}

export function ConnectorIcon(props: Props): React.ReactElement {
    let icon = "";
    switch (props.variant) {
        case ConnectorIconVariant.COLORED:
            icon = props.connector.icons.colored;
            break;
        case ConnectorIconVariant.UNCOLORED:
            icon = props.connector.icons.uncolored;
            break;
        case ConnectorIconVariant.OUTLINES:
            icon = props.connector.icons.outlines;
            break;
    }
    return (
        <svg width="20px" height="20px">
            <use xlinkHref={`${icons}#${icon}`} />
        </svg>
    );
}
