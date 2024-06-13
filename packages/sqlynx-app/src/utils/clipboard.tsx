import * as React from "react";

import { CheckIcon, CopyIcon, Icon } from "@primer/octicons-react";

import { useLogger } from "../platform/logger_provider.js";
import { TextInputAction } from '../view/foundations/text_input_action.js';

const DEFAULT_COPY_TIMEOUT = 2000;

export function CopyToClipboardAction(props: { value: string, timeoutMs?: number, logContext: string, ariaLabel: string }): React.ReactElement {
    const logger = useLogger();
    const [lastCopied, setLastCopied] = React.useState<number | null>(null);
    const [wasRecentlyCopied, setWasRecentlyCopied] = React.useState<boolean>(false);
    const timeoutMs = props.timeoutMs ?? DEFAULT_COPY_TIMEOUT;

    const copy = React.useCallback(async () => {
        try {
            await navigator.clipboard.writeText(props.value);
            logger.error(`copied ${props.value.length} characters to clipboard`, props.logContext);
            setLastCopied(Date.now());
        } catch (e: any) {
            logger.error(`copying failed with error: ${e.toString()}`, props.logContext);
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
        icon = CopyIcon;
    }
    return (
        <TextInputAction
            onClick={copy}
            icon={icon}
            aria-label={props.ariaLabel}
            aria-labelledby=""
        />
    );
}
