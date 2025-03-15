import * as React from 'react';
import * as icons from '../../static/svg/symbols.generated.svg';

import { AnchoredOverlay } from './foundations/anchored_overlay.js';
import { AnchorAlignment, AnchorSide } from './foundations/anchored_position.js';
import { VerticalTabs, VerticalTabVariant } from './foundations/vertical_tabs.js';
import { OverlaySize } from './foundations/overlay.js';
import { AppSettings } from './app_settings_view.js';
import { LogViewer } from './log_viewer.js';
import { QueryLogViewer } from './query_status/query_log_viewer.js';

interface InternalsViewerProps {
    onClose: () => void;
}

enum TabKey {
    LogViewer = 0,
    QueryViewer = 1,
    AppSettings = 2,
}

export const InternalsViewer: React.FC<InternalsViewerProps> = (props: InternalsViewerProps) => {
    const [selectedTab, selectTab] = React.useState<TabKey>(TabKey.LogViewer);

    return (
        <VerticalTabs
            variant={VerticalTabVariant.Stacked}
            selectedTab={selectedTab}
            selectTab={selectTab}
            tabProps={{
                [TabKey.LogViewer]: {
                    tabId: TabKey.LogViewer,
                    icon: `${icons}#log`,
                    labelShort: 'Logs',
                    disabled: false
                },
                [TabKey.QueryViewer]: {
                    tabId: TabKey.QueryViewer,
                    icon: `${icons}#database`,
                    labelShort: 'Queries',
                    disabled: false,
                },
                [TabKey.AppSettings]: {
                    tabId: TabKey.AppSettings,
                    icon: `${icons}#settings`,
                    labelShort: 'Settings',
                    disabled: false,
                },
            }}
            tabKeys={[TabKey.LogViewer, TabKey.QueryViewer, TabKey.AppSettings]}
            tabRenderers={{
                [TabKey.LogViewer]: _props => (
                    <LogViewer onClose={props.onClose} />
                ),
                [TabKey.QueryViewer]: _props => (
                    <QueryLogViewer onClose={props.onClose} />
                ),
                [TabKey.AppSettings]: _props => (
                    <AppSettings onClose={props.onClose} />
                ),
            }}
        />
    );
}

type InternalsViewerOverlayProps = {
    isOpen: boolean;
    onClose: () => void;
    renderAnchor: (p: object) => React.ReactElement;
    side?: AnchorSide;
    align?: AnchorAlignment;
    anchorOffset?: number;
}
export function InternalsViewerOverlay(props: InternalsViewerOverlayProps) {
    return (
        <AnchoredOverlay
            open={props.isOpen}
            onClose={props.onClose}
            renderAnchor={props.renderAnchor}
            side={props.side}
            align={props.align}
            anchorOffset={props.anchorOffset}
            overlayProps={{
                width: OverlaySize.XL,
                height: OverlaySize.L,
            }}
        >
            <InternalsViewer onClose={props.onClose} />
        </AnchoredOverlay>
    );
}
