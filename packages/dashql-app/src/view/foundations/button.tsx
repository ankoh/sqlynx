import * as React from 'react';
import * as styles from './button.module.css';

import { Tooltip } from './tooltip.js';
import { classNames } from '../../utils/classnames.js';

const BUTTON_VARIANT_CLASSNAME = [
    styles.button_variant_default,
    styles.button_variant_primary,
    styles.button_variant_danger,
    styles.button_variant_invisible,
];
const BUTTON_SIZE_CLASSNAME = [
    styles.button_size_small,
    styles.button_size_medium,
    styles.button_size_large,
];

export enum ButtonVariant {
    Default,
    Primary,
    Danger,
    Invisible,
    Outline,
}

export function mapButtonVariant(variant: ButtonVariant) {
    switch (variant) {
        case ButtonVariant.Default: return 'default';
        case ButtonVariant.Primary: return 'primary';
        case ButtonVariant.Danger: return 'danger';
        case ButtonVariant.Invisible: return 'invisible';
        case ButtonVariant.Outline: return 'outline';
    }
}

export enum ButtonSize {
    Small,
    Medium,
    Large
}

export function mapButtonSize(size: ButtonSize) {
    switch (size) {
        case ButtonSize.Small: return 'small';
        case ButtonSize.Medium: return 'medium';
        case ButtonSize.Large: return 'large';
    }
}

interface ButtonProps {
    className?: string;
    variant?: ButtonVariant;
    size?: ButtonSize;
    disabled?: boolean;
    inactive?: boolean;
    block?: boolean;
    leadingVisual?: React.ElementType;
    trailingVisual?: React.ElementType;
    trailingAction?: React.ReactElement<React.HTMLProps<HTMLButtonElement>>;
    children?: React.ReactElement | string;
    onClick?: React.MouseEventHandler;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>((props: ButtonProps, ref) => {
    const variantStyle = BUTTON_VARIANT_CLASSNAME[props.variant ?? ButtonVariant.Default];
    const sizeStyle = BUTTON_SIZE_CLASSNAME[props.size ?? ButtonSize.Medium];
    return (
        <button
            className={classNames(styles.button, variantStyle, sizeStyle, {
                [styles.inactive]: props.inactive,
                [styles.block]: props.block,
                [styles.disabled]: props.disabled,
                [styles.no_visuals]: !props.leadingVisual && !props.trailingVisual && !props.trailingAction ? true : undefined,
            }, props.className)}
            onClick={props.onClick}
            ref={ref}
        >
            <span className={styles.button_content}>
                {props.leadingVisual && (
                    <span className={styles.leading_visual}><props.leadingVisual /></span>
                )}
                {props.children && (
                    <span className={styles.text}>{props.children}</span>
                )}
                {props.trailingVisual && (
                    <span className={styles.trailing_visual}><props.trailingVisual /></span>
                )}
            </span>
            {props.trailingAction && (
                <span className={styles.trailing_action}>
                    {props.trailingAction}
                </span>
            )}
        </button>
    );
});

interface IconButtonProps {
    className?: string;
    variant?: ButtonVariant;
    size?: ButtonSize;
    disabled?: boolean;
    inactive?: boolean;
    children?: React.ReactElement | string;
    onClick?: React.MouseEventHandler;
    description?: string;
    'aria-label': string;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>((props: IconButtonProps, ref) => {
    const ariaLabel = props['aria-label'];
    const variantStyle = BUTTON_VARIANT_CLASSNAME[props.variant ?? ButtonVariant.Default];
    const sizeStyle = BUTTON_SIZE_CLASSNAME[props.size ?? ButtonSize.Medium];
    return (
        <Tooltip
            text={props.description ?? ariaLabel}
            type={props.description ? undefined : 'label'}
        >
            <button
                className={classNames(styles.button, variantStyle, sizeStyle, {
                    [styles.inactive]: props.inactive,
                    [styles.disabled]: props.disabled,
                }, props.className)}
                onClick={props.onClick}
                ref={ref}
            >
                {props.children}
            </button>
        </Tooltip>
    );
});