import * as React from 'react';
import icons from '@ankoh/dashql-svg-symbols';

import { AnchorAlignment, AnchorSide } from '../../../ui/foundations/anchored_position.js';
import { AnchoredOverlay } from '../../../ui/foundations/anchored_overlay.js';
import { AppSettings } from './app_settings_view.js';
import { AISettingsView } from './ai_settings_view.js';
import { StorageWriterView } from '../../notebook/persistence/ui/storage_writer_view.js';
import { LogViewer } from '../../../ui/logs/log_viewer.js';
import { OverlaySize } from '../../../ui/foundations/overlay.js';
import { QueryViewer } from '../../notebook/connections/ui/query_viewer.js';
import { QueryCacheView } from '../../notebook/persistence/ui/query_cache_view.js';
import { VerticalTabs, VerticalTabVariant } from '../../../ui/foundations/vertical_tabs.js';

interface InternalsViewerProps {
    /// The active notebook UUID, used by notebook-scoped tabs (e.g. the query cache inspector).
    notebookId: string | null;
    onClose: () => void;
}

enum TabKey {
    LogViewer = 0,
    QueryViewer = 1,
    AppSettings = 2,
    StorageWriter = 3,
    QueryCache = 4,
    AISettings = 5,
}

export const InternalsViewer: React.FC<InternalsViewerProps> = (props: InternalsViewerProps) => {
    const [selectedTab, selectTab] = React.useState<TabKey>(TabKey.LogViewer);
    const tabKeys = [TabKey.LogViewer, TabKey.QueryViewer, TabKey.QueryCache, TabKey.StorageWriter, TabKey.AISettings, TabKey.AppSettings];

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
                    disabled: false
                },
                [TabKey.QueryViewer]: {
                    tabId: TabKey.QueryViewer,
                    icon: `${icons}#database`,
                    labelShort: 'Queries',
                    ariaLabel: 'Query history',
                    description: 'View query execution history',
                    disabled: false,
                },
                [TabKey.StorageWriter]: {
                    tabId: TabKey.StorageWriter,
                    icon: `${icons}#versions_24`,
                    labelShort: 'Storage Writer',
                    ariaLabel: 'Storage writer',
                    description: 'View storage writer statistics',
                    disabled: false,
                },
                [TabKey.QueryCache]: {
                    tabId: TabKey.QueryCache,
                    icon: `${icons}#cache_24`,
                    labelShort: 'Query Cache',
                    ariaLabel: 'Query result cache',
                    description: 'Inspect and evict cached query results',
                    disabled: false,
                },
                [TabKey.AISettings]: {
                    tabId: TabKey.AISettings,
                    icon: `${icons}#sparkles_fill_24`,
                    labelShort: 'AI',
                    ariaLabel: 'AI provider settings',
                    description: 'Configure the AI provider',
                    disabled: false,
                },
                [TabKey.AppSettings]: {
                    tabId: TabKey.AppSettings,
                    icon: `${icons}#settings_24`,
                    labelShort: 'Settings',
                    ariaLabel: 'Application settings',
                    description: 'Configure application settings',
                    disabled: false,
                },
            }}
            tabKeys={tabKeys}
            tabRenderers={{
                [TabKey.LogViewer]: _props => (
                    <LogViewer onClose={props.onClose} />
                ),
                [TabKey.QueryViewer]: _props => (
                    <QueryViewer onClose={props.onClose} />
                ),
                [TabKey.StorageWriter]: _props => (
                    <StorageWriterView notebookId={props.notebookId} onClose={props.onClose} />
                ),
                [TabKey.QueryCache]: _props => (
                    <QueryCacheView notebookId={props.notebookId} onClose={props.onClose} />
                ),
                [TabKey.AISettings]: _props => (
                    <AISettingsView onClose={props.onClose} />
                ),
                [TabKey.AppSettings]: _props => (
                    <AppSettings onClose={props.onClose} />
                ),
            }}
        />
    );
}

type InternalsViewerOverlayProps = {
    /// The active notebook UUID, forwarded to notebook-scoped tabs (e.g. the query cache inspector).
    /// Omitted on setup/loading pages that have no active notebook — the query cache tab then shows
    /// an empty "no active notebook" state.
    notebookId?: string | null;
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
            <InternalsViewer notebookId={props.notebookId ?? null} onClose={props.onClose} />
        </AnchoredOverlay>
    );
}
