import * as React from 'react';
import { Link } from 'react-router-dom';
import { classNames } from '../utils/classnames.js';

import styles from './navbar_button.module.css';

export enum HoverMode {
    Invert,
    Darken,
    Lighten,
}

type LinkProps = {
    className?: string;
    to: string;
    hover?: HoverMode;
    invert?: boolean;
    children?: React.ReactElement;
    newWindow?: boolean;
};

export const NavBarLink: React.FC<LinkProps> = (props: LinkProps) => (
    <Link
        className={classNames(props.className, {
            [styles.button]: props.invert === undefined || !props.invert,
            [styles.button_inverted]: props.invert,
            [styles.hover_invert]: props.hover === undefined || props.hover === HoverMode.Invert,
            [styles.hover_lighten]: props.hover === HoverMode.Lighten,
            [styles.hover_darken]: props.hover === HoverMode.Darken,
        })}
        to={props.to}
        target={props.newWindow ? '_blank' : undefined}
    >
        {props.children}
    </Link>
);

type ButtonProps = {
    className?: string;
    hover?: HoverMode;
    invert?: boolean;
    children?: React.ReactElement | string;
    onClick?: (event: React.MouseEvent) => void;
};

export const NavBarButton: React.FC<ButtonProps> = (props: ButtonProps) => (
    <button
        className={classNames(props.className, {
            [styles.button]: props.invert === undefined || !props.invert,
            [styles.button_inverted]: props.invert,
            [styles.hover_invert]: props.hover === undefined || props.hover === HoverMode.Invert,
            [styles.hover_lighten]: props.hover === HoverMode.Lighten,
            [styles.hover_darken]: props.hover === HoverMode.Darken,
        })}
        onClick={props.onClick}
    >
        {props.children}
    </button>
);

export const NavBarButtonWithRef = React.forwardRef((props: ButtonProps, ref: React.ForwardedRef<HTMLButtonElement>) => (
    <button
        ref={ref}
        className={classNames(props.className, {
            [styles.button]: props.invert === undefined || !props.invert,
            [styles.button_inverted]: props.invert,
            [styles.hover_invert]: props.hover === undefined || props.hover === HoverMode.Invert,
            [styles.hover_lighten]: props.hover === HoverMode.Lighten,
            [styles.hover_darken]: props.hover === HoverMode.Darken,
        })}
        onClick={props.onClick}
    >
        {props.children}
    </button>
))
