import * as React from 'react';
import icons from '@ankoh/dashql-svg-symbols';

import { AnchorAlignment, AnchorSide } from '../ui/foundations/anchored_position.js';
import { AnchoredOverlay } from '../ui/foundations/anchored_overlay.js';
import { OverlaySize } from '../ui/foundations/overlay.js';
import { VerticalTabs, VerticalTabVariant } from '../ui/foundations/vertical_tabs.js';
import { LogViewer } from '../ui/logs/log_viewer.js';
import { QueryViewer } from '../app/notebook/connections/ui/query_viewer.js';
import { AISettingsView } from '../ui/ai/ai_settings_view.js';
import * as styles from './shell_navbar.module.css';

enum TabKey {
    LogViewer = 0,
    QueryViewer = 1,
    AISettings = 2,
}

interface ShellInternalsProps {
    /// Show the AI model settings, the page has to provide an AIModelsProvider
    aiSettings?: boolean;
}

interface ShellInternalsViewerProps extends ShellInternalsProps {
    onClose: () => void;
}

export const ShellInternalsViewer: React.FC<ShellInternalsViewerProps> = props => {
    const [selectedTab, selectTab] = React.useState<TabKey>(TabKey.LogViewer);
    const tabKeys = props.aiSettings
        ? [TabKey.LogViewer, TabKey.QueryViewer, TabKey.AISettings]
        : [TabKey.LogViewer, TabKey.QueryViewer];

    return (
        <VerticalTabs
            variant={VerticalTabVariant.Stacked}
            selectedTab={selectedTab}
            selectTab={selectTab}
            tabProps={{
                [TabKey.LogViewer]: {
                    tabId: TabKey.LogViewer,
                    icon: `${icons}#log_24`,
                    labelShort: 'Logs',
                    ariaLabel: 'Application logs',
                    description: 'View application logs',
                    disabled: false,
                },
                [TabKey.QueryViewer]: {
                    tabId: TabKey.QueryViewer,
                    icon: `${icons}#database`,
                    labelShort: 'Queries',
                    ariaLabel: 'Query history',
                    description: 'View query execution history',
                    disabled: false,
                },
                [TabKey.AISettings]: {
                    tabId: TabKey.AISettings,
                    icon: `${icons}#pencil_ai_16`,
                    labelShort: 'AI',
                    ariaLabel: 'AI model settings',
                    description: 'Configure the AI models',
                    disabled: false,
                },
            }}
            tabKeys={tabKeys}
            tabRenderers={{
                [TabKey.LogViewer]: () => <LogViewer onClose={props.onClose} />,
                [TabKey.QueryViewer]: () => <QueryViewer onClose={props.onClose} />,
                [TabKey.AISettings]: () => <AISettingsView onClose={props.onClose} />,
            }}
        />
    );
};

export const ShellInternals: React.FC<ShellInternalsProps> = (internalsProps: ShellInternalsProps) => {
    const [isOpen, setIsOpen] = React.useState(false);
    const close = React.useCallback(() => setIsOpen(false), []);

    return (
        <AnchoredOverlay
            open={isOpen}
            onOpen={() => setIsOpen(true)}
            onClose={close}
            side={AnchorSide.OutsideBottom}
            align={AnchorAlignment.End}
            anchorOffset={16}
            overlayProps={{ width: OverlaySize.XL, height: OverlaySize.L }}
            renderAnchor={(props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
                <button
                    {...props}
                    type="button"
                    className={styles.actionButton}
                >
                    <svg width="14px" height="14px" aria-hidden="true">
                        <use xlinkHref={`${icons}#processor`} />
                    </svg>
                    <span className={styles.actionLabel}>Internals</span>
                </button>
            )}
        >
            <ShellInternalsViewer onClose={close} aiSettings={internalsProps.aiSettings} />
        </AnchoredOverlay>
    );
};
