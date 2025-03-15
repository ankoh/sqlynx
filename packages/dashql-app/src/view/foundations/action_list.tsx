import * as React from "react";

import * as styles from "./action_list.module.css";
import { classNames } from '../../utils/classnames.js';

export interface ListProps {
    children?: React.ReactElement | React.ReactElement[];
    leading?: boolean;
    trailing?: boolean;
}

export function List(props: ListProps) {
    return (
        <div className={styles.list_container}>
            {props.children}
        </div>
    );
}

export interface ListItemProps {
    children?: React.ReactElement | React.ReactElement[];
    onClick?: (ev: React.MouseEvent) => void;
    disabled?: boolean;
    selected?: boolean;
    'data-item'?: string;
}

export function ListItem(props: ListItemProps) {
    return (
        <button
            className={classNames(styles.item_container, {
                [styles.disabled]: props.disabled,
                [styles.selected]: props.selected
            })}
            onClick={props.onClick}
            disabled={props.disabled}
            data-item={props['data-item']}
        >
            {props.children}
        </button>
    );
}

export interface LeadingProps {
    children?: React.ReactElement | string;
}

export function Leading(props: LeadingProps) {
    return (
        <span className={styles.leading_container}>
            {props.children}
        </span>
    );
}

export interface TrailingProps {
    children?: React.ReactElement | string;
}

export function Trailing(props: TrailingProps) {
    return (
        <span className={styles.trailing_container}>
            {props.children}
        </span>
    );
}

export interface GroupHeadingProps {
    children?: string;
}

export function GroupHeading(props: GroupHeadingProps) {
    return (
        <span className={styles.group_heading_container}>
            {props.children}
        </span>
    );
}

export interface ItemTextProps {
    children?: undefined | string | React.ReactElement | (undefined | string | React.ReactElement)[];
}

export function ItemText(props: ItemTextProps) {
    return <span className={styles.text_container}>{props.children}</span>;
}
export function ItemTextTitle(props: ItemTextProps) {
    return <span className={styles.text_title}>{props.children}</span>;
}
export function ItemTextDescription(props: ItemTextProps) {
    return <span className={styles.text_description}>{props.children}</span>;
}

export function Divider() {
    return <div className={styles.divider} />;
}
