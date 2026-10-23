import * as React from 'react';
import * as styles from './tag.module.css';

import { classNames } from '../../utils/classnames.js';

/// The look of a tag
export enum TagVariant {
    /// A light fill with a hairline border, for tags on light surfaces
    Muted,
    /// A transparent background with a hairline border
    Outline,
}

interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
    /// The look of the tag
    variant?: TagVariant;
}

/// A small tag that labels something, e.g. the protocol of a connection.
/// The text keeps its casing, callers transform it if they need to.
export function Tag(props: TagProps): React.ReactElement {
    const { variant = TagVariant.Muted, className, ...rest } = props;
    return (
        <span
            {...rest}
            className={classNames(styles.tag, variant === TagVariant.Outline ? styles.outline : styles.muted, className)}
        />
    );
}
