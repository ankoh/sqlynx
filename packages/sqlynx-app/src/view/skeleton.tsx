import React, { PropsWithChildren, ReactElement } from 'react';

import styles from './skeleton.module.css';

export interface SkeletonProps {
    width?: string | number;
    height?: string | number;
    inline?: boolean;
    count?: number;
    wrapper?: React.FunctionComponent<PropsWithChildren<unknown>>;
    className?: string;
    circle?: boolean;
}

export function Skeleton(props: SkeletonProps): ReactElement {
    const baseStyle = {
        width: props.width,
        height: props.height,
    };
    const inline = props.inline ?? false;
    const elements: ReactElement[] = [];
    const count = props.count === undefined ? 1 : props.count;
    const countCeil = Math.ceil(count);

    for (let i = 0; i < countCeil; i++) {
        let thisStyle = baseStyle;
        if (countCeil > count && i === countCeil - 1) {
            const width = thisStyle.width ?? '100%';
            const fractionalPart = count % 1;
            const fractionalWidth =
                typeof width === 'number' ? width * fractionalPart : `calc(${width} * ${fractionalPart})`;

            thisStyle = { ...thisStyle, width: fractionalWidth };
        }
        const skeletonSpan = (
            <span className={styles.react_loading_skeleton} style={thisStyle} key={i}>
                &zwnj;
            </span>
        );
        if (inline) {
            elements.push(skeletonSpan);
        } else {
            elements.push(
                <React.Fragment key={i}>
                    {skeletonSpan}
                    <br />
                </React.Fragment>,
            );
        }
    }
    return (
        <div className={props.className} aria-live="polite" aria-busy={true}>
            {elements}
        </div>
    );
}
