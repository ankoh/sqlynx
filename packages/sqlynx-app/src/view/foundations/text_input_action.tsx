import * as React from 'react'
import * as styles from './text_input_action.module.css';

import type { IconProps } from '@primer/octicons-react'
import { IconButton } from '@primer/react';
import { Tooltip } from './tooltip.js';
import { CopyToClipboardButton } from '../../utils/clipboard.js';

interface TextInputActionProps {
    children?: React.ReactElement;
    /// Text that appears in a tooltip. If an icon is passed, this is also used as the label used by assistive technologies.
    ['aria-label']: string;
    ['aria-labelledby']: string;
    /// Position of tooltip. If no position is passed or defaults to "n"
    tooltipDirection?: 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
    /// The icon to render inside the button
    icon?: React.FunctionComponent<React.PropsWithChildren<IconProps>>;
}
type Props = TextInputActionProps & React.ButtonHTMLAttributes<HTMLButtonElement>;

export function TextInputAction(props: Props) {
    const ariaLabel = props['aria-label'];
    const ariaLabelledBy = props['aria-labelledby'];

    if ((props.icon && !ariaLabel) || (!props.children && !ariaLabel)) {
        console.warn('Use the `aria-label` prop to provide an accessible label for assistive technology')
    }
    // marginLeft={1} marginRight={1} lineHeight="0"
    return (
        <Tooltip text={ariaLabel} type="label" direction="s">
            <IconButton
                className={styles.input_action}
                type="button"
                icon={props.icon}
                variant="invisible"
                size="small"
                aria-labelledby={ariaLabelledBy}
                onClick={props.onClick}
            />
        </Tooltip>
    );
}

interface CopyToClipboardActionProps {
    value: string;
    timeoutMs?: number;
    logContext: string;
    ariaLabel: string;
}

export function CopyToClipboardAction(props: CopyToClipboardActionProps): React.ReactElement {
    return (
        <CopyToClipboardButton
            className={styles.input_action}
            aria-label={props.ariaLabel}
            aria-labelledby={''}
            timeoutMs={props.timeoutMs}
            logContext={props.logContext}
            value={props.value}
        />
    );
}
