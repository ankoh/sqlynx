import * as React from 'react';

import { CheckIcon, CopyIcon, Icon } from '@primer/octicons-react';

import { useLogger } from '../platform/logger_provider.js';
import { Tooltip } from '../view/foundations/tooltip.js';
import { IconButton } from '@primer/react';
import { ButtonSize, ButtonVariant, mapButtonSize, mapButtonVariant } from '../view/foundations/button.js';

const DEFAULT_COPY_TIMEOUT = 2000;

interface Props {
    variant: ButtonVariant;
    size: ButtonSize;
    className?: string;
    value: string;
    timeoutMs?: number;
    logContext: string;
    disabled?: boolean;
    icon?: Icon;
    ['aria-label']: string;
    ['aria-labelledby']: string;
}
/// The icon to render inside the button
export function CopyToClipboardButton(props: Props): React.ReactElement {
    const logger = useLogger();
    const [lastCopied, setLastCopied] = React.useState<number | null>(null);
    const [wasRecentlyCopied, setWasRecentlyCopied] = React.useState<boolean>(false);
    const timeoutMs = props.timeoutMs ?? DEFAULT_COPY_TIMEOUT;

    const copy = React.useCallback(async () => {
        try {
            await navigator.clipboard.writeText(props.value);
            logger.error("copied to clipboard", { "chars": props.value.length.toString() }, props.logContext);
            setLastCopied(Date.now());
        } catch (e: any) {
            logger.error("copying failed", { "error": e.toString() }, props.logContext);
        }
    }, [setLastCopied, props.value]);

    React.useEffect(() => {
        if (lastCopied == null) {
            return;
        }
        setWasRecentlyCopied(true);
        const timeoutId = setTimeout(() => {
            setWasRecentlyCopied(false);
        }, timeoutMs);
        return () => clearTimeout(timeoutId);
    }, [lastCopied]);

    let icon: Icon;
    if (wasRecentlyCopied) {
        icon = CheckIcon;
    } else {
        icon = props.icon ?? CopyIcon;
    }

    const ariaLabel = props['aria-label'];
    const ariaLabelledBy = props['aria-labelledby'];
    const buttonVariant = mapButtonVariant(props.variant);
    const buttonSize = mapButtonSize(props.size);
    return (
        <Tooltip text={ariaLabel} type="label" direction="s">
            <IconButton
                className={props.className}
                type="button"
                icon={icon}
                variant={buttonVariant}
                size={buttonSize}
                onClick={copy}
                aria-labelledby={ariaLabelledBy}
            />
        </Tooltip>
    );
}
