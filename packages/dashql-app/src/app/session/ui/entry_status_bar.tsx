import * as React from 'react';
import * as styles from './entry_status_bar.module.css';

import { EntryStatus } from './entry_status_model.js';
import { StatusIndicator } from '../../../ui/foundations/status_indicator.js';
import { AnchoredOverlay } from '../../../ui/foundations/anchored_overlay.js';
import { AnchorAlignment, AnchorSide } from '../../../ui/foundations/anchored_position.js';
import { ButtonSize, ButtonVariant, IconButton } from '../../../ui/foundations/button.js';
import { JsonView } from '../../../ui/json/json_view.js';
import { SymbolIcon } from '../../../ui/foundations/symbol_icon.js';
import { ChevronDownIcon, ChevronRightIcon } from '../../../ui/foundations/symbol_icon.js';
import { classNames } from '../../../utils/classnames.js';

export interface EntryStatusBarDependencies {
    AnchoredOverlay: typeof AnchoredOverlay;
}

const DEFAULT_DEPENDENCIES: EntryStatusBarDependencies = {
    AnchoredOverlay,
};

interface EntryStatusBarProps {
    /// The derived status to show. When null the caller shouldn't render the bar at all.
    status: EntryStatus;
    /// Toggle the result content below this status header.
    onToggleExpanded?: () => void;
    expanded?: boolean;
    controls?: string;
    /// Cancel the in-flight work represented by this status. When set, a visible Cancel button is
    /// rendered at the right edge without making the whole bar a nested button.
    onCancel?: () => void;
    cancelLabel?: string;
    /// Result-level actions such as execution age and Refresh. Kept outside the clickable log strip
    /// so the bar never nests interactive controls.
    actions?: React.ReactNode;
    compact?: boolean;
    dependencies?: EntryStatusBarDependencies;
}

const ErrorDetailCard: React.FC<{
    detail: Record<string, unknown>;
    onClose: () => void;
}> = ({ detail, onClose }) => {
    const CloseIcon = SymbolIcon('x_16');
    return (
        <section className={styles.error_detail_card} role="dialog" aria-label="Query error details">
            <header className={styles.error_detail_header}>
                <h2 className={styles.error_detail_title}>Query error details</h2>
                <IconButton
                    variant={ButtonVariant.Invisible}
                    size={ButtonSize.Small}
                    onClick={onClose}
                    aria-label="Close query error details"
                >
                    <CloseIcon size={16} />
                </IconButton>
            </header>
            <JsonView
                className={styles.error_detail_json}
                value={detail}
                collapsed={2}
                shortenTextAfterLength={100}
            />
        </section>
    );
};

/// The result-card header: it renders a spinner (or check/cross) plus a one-line status message and
/// optionally toggles the result content below it. Failed-query details are available from a
/// separate control so the toggle never contains nested interactive elements.
export const EntryStatusBar: React.FC<EntryStatusBarProps> = ({ status, onToggleExpanded, expanded, controls, onCancel, cancelLabel = 'Cancel operation', actions, compact, dependencies = DEFAULT_DEPENDENCIES }) => {
    const [showDetail, setShowDetail] = React.useState(false);
    const hasErrorDetail = status.errorDetail != null;
    const CancelIcon = SymbolIcon('x_16');
    const InfoIcon = SymbolIcon('info_circle_16');
    const AnchoredOverlayComponent = dependencies.AnchoredOverlay;

    const message = (
        <span className={styles.status_bar_message}>
            {status.message}
        </span>
    );
    // Keep error details separate from the log button. Nesting the overlay's focusable anchor inside
    // that button would create two interactive controls in one another.
    const errorDetail = hasErrorDetail ? (
        <AnchoredOverlayComponent
            open={showDetail}
            onOpen={() => setShowDetail(true)}
            onClose={() => setShowDetail(false)}
            side={AnchorSide.OutsideBottom}
            align={AnchorAlignment.End}
            anchorOffset={4}
            renderAnchor={(p: object) => {
                const anchorProps = p as React.ButtonHTMLAttributes<HTMLButtonElement>;
                return (
                    <IconButton
                        {...anchorProps}
                        variant={ButtonVariant.Invisible}
                        className={styles.error_detail_trigger}
                        aria-label="Show error details"
                    >
                        <InfoIcon size={16} />
                    </IconButton>
                );
            }}
        >
            <ErrorDetailCard detail={status.errorDetail!} onClose={() => setShowDetail(false)} />
        </AnchoredOverlayComponent>
    ) : null;
    const indicator = (
        <StatusIndicator
            className={styles.status_bar_spinner}
            status={status.indicator}
            width="14px"
            height="14px"
            fill="currentColor"
        />
    );

    return (
        <div className={classNames(styles.status_bar, {
            [styles.status_bar_collapsed]: expanded === false,
            [styles.status_bar_compact]: compact,
        })}>
            {onToggleExpanded != null ? (
                <button
                    type="button"
                    className={styles.status_bar_log_button}
                    onClick={onToggleExpanded}
                    aria-label={`${expanded ? 'Collapse' : 'Expand'} result: ${status.message}`}
                    aria-expanded={expanded}
                    aria-controls={controls}
                >
                    {expanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
                    {indicator}
                    {message}
                </button>
            ) : (
                <div className={styles.status_bar_content}>
                    {indicator}
                    {message}
                </div>
            )}
            {onCancel != null && (
                <IconButton
                    variant={ButtonVariant.Invisible}
                    className={styles.status_bar_cancel}
                    onClick={onCancel}
                    aria-label={cancelLabel}
                >
                    <CancelIcon size={16} />
                </IconButton>
            )}
            {errorDetail}
            {actions != null && (
                <div className={styles.status_bar_actions}>{actions}</div>
            )}
        </div>
    );
};
