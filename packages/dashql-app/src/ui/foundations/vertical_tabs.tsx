import * as React from 'react';

import { classNames } from '../../utils/classnames.js';
import icons from '@ankoh/dashql-svg-symbols';
import { IconButton, ButtonVariant } from './button.js';

import * as styles from './vertical_tabs.module.css';

const VSPLIT_DEFAULT_RATIO = 0.4;

type Key = number;

export interface VerticalTabRenderers<TabProps extends VerticalTabProps> {
    [key: Key]: (props: TabProps) => React.ReactElement;
}

export interface VerticalTabProps {
    tabId: number;
    icon: string;
    iconActive?: string;
    labelShort: string;
    labelLong?: string;
    disabled?: boolean;
    ariaLabel?: string;
    description?: string;
    /// The group of the tab, consecutive tabs of the same group are separated from other groups by a bar
    group?: string;
}

export enum VerticalTabVariant {
    Stacked = 0,
}

interface Props<TabProps extends VerticalTabProps> {
    className?: string;
    variant: VerticalTabVariant;
    tabKeys: Key[];
    tabProps: Record<Key, TabProps>;
    tabRenderers: VerticalTabRenderers<TabProps>;
    selectedTab: Key;
    selectTab: (tab: Key) => void;

    splitModeEnabled?: boolean;
    splitTab?: Key | null;
    primaryTabKey?: Key;
    onToggleSplitMode?: () => void;
    onSelectSplitTab?: (tab: Key) => void;
}

/// Split the tabs into runs of consecutive tabs of the same group
export function groupVerticalTabs<TabProps extends VerticalTabProps>(tabKeys: Key[], tabProps: Record<Key, TabProps>): TabProps[][] {
    const groups: TabProps[][] = [];
    for (const key of tabKeys) {
        const tab = tabProps[key];
        const last = groups[groups.length - 1];
        if (last != null && last[0].group === tab.group) {
            last.push(tab);
        } else {
            groups.push([tab]);
        }
    }
    return groups;
}

export function VerticalTabs<TabProps extends VerticalTabProps>(props: Props<TabProps>): React.ReactElement {
    const [splitRatio, setSplitRatio] = React.useState(VSPLIT_DEFAULT_RATIO);
    const [isDragging, setIsDragging] = React.useState(false);
    const containerRef = React.useRef<HTMLDivElement>(null);

    const selectTab = React.useCallback((tabId: number) => {
        if (props.splitModeEnabled) {
            // In split mode, clicking primary tab does nothing
            if (tabId === props.primaryTabKey) {
                return;
            }
            // Clicking other tabs sets them as the split tab
            if (props.onSelectSplitTab) {
                props.onSelectSplitTab(tabId);
            }
        } else {
            // Normal mode: select the tab as the main tab
            props.selectTab(tabId);
        }
    }, [props.splitModeEnabled, props.primaryTabKey, props.onSelectSplitTab, props.selectTab]);

    const handleResizeStart = React.useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        setIsDragging(true);
    }, []);

    const handleResizeMove = React.useCallback((e: MouseEvent) => {
        if (!isDragging || !containerRef.current) return;

        const container = containerRef.current;
        const rect = container.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const newRatio = Math.max(0.2, Math.min(0.8, y / rect.height));
        setSplitRatio(newRatio);
    }, [isDragging]);

    const handleResizeEnd = React.useCallback(() => {
        setIsDragging(false);
    }, []);

    React.useEffect(() => {
        if (isDragging) {
            document.addEventListener('mousemove', handleResizeMove);
            document.addEventListener('mouseup', handleResizeEnd);
            return () => {
                document.removeEventListener('mousemove', handleResizeMove);
                document.removeEventListener('mouseup', handleResizeEnd);
            };
        }
    }, [isDragging, handleResizeMove, handleResizeEnd]);

    // Render primary tab body.
    // The bodies are memoized to not re-render them for every mouse move while dragging the split.
    const primaryTabKey = props.splitModeEnabled ? props.primaryTabKey ?? props.selectedTab : props.selectedTab;
    const primaryTabRenderer = props.tabRenderers[primaryTabKey];
    const primaryTabBodyProps = props.tabProps[primaryTabKey];
    const primaryTabBody = React.useMemo(
        () => primaryTabRenderer ? primaryTabRenderer(primaryTabBodyProps) : undefined,
        [primaryTabRenderer, primaryTabBodyProps],
    );

    // Render split tab body if split mode is enabled
    const splitTabRenderer = (props.splitModeEnabled && props.splitTab != null) ? props.tabRenderers[props.splitTab] : null;
    const splitTabBodyProps = props.splitTab != null ? props.tabProps[props.splitTab] : undefined;
    const splitTabBody = React.useMemo(
        () => splitTabRenderer ? splitTabRenderer(splitTabBodyProps!) : undefined,
        [splitTabRenderer, splitTabBodyProps],
    );

    const renderStackedTab = (tabProps: VerticalTabProps) => {
        const isPrimaryTab = props.splitModeEnabled && tabProps.tabId === props.primaryTabKey;
        const isActive = isPrimaryTab || tabProps.tabId == props.selectedTab || (props.splitModeEnabled && tabProps.tabId === props.splitTab);
        const isSplitTab = props.splitModeEnabled && tabProps.tabId === props.splitTab;
        const showSplitIndicator = isPrimaryTab || isSplitTab;
        const splitNumber = isPrimaryTab ? '1' : '2';

        const tooltipText = tabProps.description || tabProps.ariaLabel || tabProps.labelShort;
        const ariaLabel = tabProps.ariaLabel || tabProps.labelShort;

        return (
            <div
                key={tabProps.tabId}
                className={classNames(styles.stacked_tab, {
                    [styles.stacked_tab_active]: isActive,
                })}
                data-tab={tabProps.tabId}
            >
                <IconButton
                    className={classNames(styles.stacked_tab_icon, {
                        [styles.stacked_tab_icon_split]: showSplitIndicator,
                    })}
                    variant={ButtonVariant.Invisible}
                    aria-label={ariaLabel}
                    aria-current={isActive ? 'page' : undefined}
                    description={tooltipText}
                    disabled={tabProps.disabled}
                    onClick={() => selectTab(tabProps.tabId)}
                >
                    {showSplitIndicator ? (
                        <>
                            <div className={styles.stacked_tab_icon_half_first}>
                                <span className={styles.stacked_tab_split_number}>{splitNumber}</span>
                            </div>
                            <div className={styles.stacked_tab_icon_half}>
                                <svg width="12px" height="12px">
                                    <use xlinkHref={(isActive && tabProps.iconActive) ? tabProps.iconActive : tabProps.icon} />
                                </svg>
                            </div>
                        </>
                    ) : (
                        <svg width="18px" height="16px">
                            <use xlinkHref={(isActive && tabProps.iconActive) ? tabProps.iconActive : tabProps.icon} />
                        </svg>
                    )}
                </IconButton>
            </div>
        );
    };

    // Check if there are at least 2 enabled tabs (so split mode makes sense)
    const enabledTabCount = props.tabKeys.filter(key => !props.tabProps[key]?.disabled).length;
    const canEnableSplit = enabledTabCount >= 2;

    const gridStyle = props.splitModeEnabled ? {
        gridTemplateRows: `${splitRatio * 100}% max-content 1fr`,
    } : undefined;

    return (
        <div
            ref={containerRef}
            className={classNames(props.className, styles.container, {
                [styles.container_split]: props.splitModeEnabled,
            })}
            style={gridStyle}
        >
            <div className={styles.tabs}>
                <div className={styles.tabs_list}>
                    {groupVerticalTabs(props.tabKeys, props.tabProps).map((group, i) => (
                        <React.Fragment key={group[0].tabId}>
                            {i > 0 && <div className={styles.tabs_separator} role="separator" aria-orientation="horizontal" />}
                            <div className={styles.tabs_group} role="group" aria-label={group[0].group}>
                                {group.map(renderStackedTab)}
                            </div>
                        </React.Fragment>
                    ))}
                </div>
                {props.onToggleSplitMode && (
                    <div className={styles.tabs_footer}>
                        <div
                            className={classNames(styles.split_toggle, {
                                [styles.split_toggle_active]: props.splitModeEnabled,
                            })}
                        >
                            <IconButton
                                className={styles.split_toggle_icon}
                                variant={ButtonVariant.Invisible}
                                aria-label="Toggle split"
                                description="Toggle split"
                                disabled={!canEnableSplit}
                                onClick={props.onToggleSplitMode}
                            >
                                <svg width="18px" height="16px">
                                    <use xlinkHref={`${icons}#vsplit_24`} />
                                </svg>
                            </IconButton>
                        </div>
                    </div>
                )}
            </div>
            <div className={styles.primary_body}>{primaryTabBody}</div>
            {props.splitModeEnabled && (
                <>
                    <div
                        className={classNames(styles.resize_handle, {
                            [styles.resize_handle_dragging]: isDragging,
                        })}
                        onMouseDown={handleResizeStart}
                    >
                        <div className={styles.resize_handle_bar} />
                    </div>
                    {splitTabBody && (
                        <div className={styles.split_body}>{splitTabBody}</div>
                    )}
                </>
            )}
        </div>
    );
};
