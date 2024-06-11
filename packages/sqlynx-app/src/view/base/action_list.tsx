import * as React from "react";

import * as styles from "./action_list.module.css";

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
}

export function ListItem(props: ListItemProps) {
    return (
        <button className={styles.item_container} onClick={props.onClick} disabled={props.disabled}>
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
    children?: string | React.ReactElement | (string | React.ReactElement)[];
}

export function ItemText(props: ItemTextProps) {
    return <span className={styles.text_container}>{props.children}</span>;
}

export function Divider() {
    return <div className={styles.divider} />;
}