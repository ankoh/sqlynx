import * as React from 'react';
import { Link } from 'react-router-dom';
import cn from 'classnames';

import styles from './button.module.css';

export enum HoverMode {
    Invert,
    Darken,
    Lighten,
}

type ButtonProps = {
    className?: string;
    disabled?: boolean;
    hover?: HoverMode;
    invert?: boolean;
    onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
    children?: React.ReactElement;
};

export const Button: React.FC<ButtonProps> = (props: ButtonProps) => (
    <div
        className={cn(props.className, {
            [styles.button]: props.invert === undefined || !props.invert,
            [styles.button_inverted]: props.invert,
            [styles.disabled]: props.disabled,
            [styles.hover_invert]: props.hover === undefined || props.hover === HoverMode.Invert,
            [styles.hover_lighten]: props.hover === HoverMode.Lighten,
            [styles.hover_darken]: props.hover === HoverMode.Darken,
        })}
        onClick={props.onClick}
    >
        {props.children}
    </div>
);
// <svg width={props.width} height={props.height}>
//     <use xlinkHref={`${props.icon}#sym`} />
// </svg>

type LinkProps = {
    className?: string;
    to: string;
    hover?: HoverMode;
    invert?: boolean;
    children?: React.ReactElement;
};

export const LinkButton: React.FC<LinkProps> = (props: LinkProps) => (
    <Link
        className={cn(props.className, {
            [styles.button]: props.invert === undefined || !props.invert,
            [styles.button_inverted]: props.invert,
            [styles.hover_invert]: props.hover === undefined || props.hover === HoverMode.Invert,
            [styles.hover_lighten]: props.hover === HoverMode.Lighten,
            [styles.hover_darken]: props.hover === HoverMode.Darken,
        })}
        to={props.to}
    >
        {props.children}
    </Link>
);
