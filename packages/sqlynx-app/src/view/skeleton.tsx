import React, { CSSProperties, PropsWithChildren, ReactElement } from 'react';

import styles from './skeleton.module.css';

const defaultEnableAnimation = true;

export interface SkeletonStyleProps {
    baseColor?: string;
    highlightColor?: string;
    width?: string | number;
    height?: string | number;
    borderRadius?: string | number;
    inline?: boolean;
    duration?: number;
    direction?: 'ltr' | 'rtl';
    enableAnimation?: boolean;
}

function styleOptionsToCssProperties({
    baseColor,
    highlightColor,
    width,
    height,
    borderRadius,
    circle,
    direction,
    duration,
    enableAnimation = defaultEnableAnimation,
}: SkeletonStyleProps & { circle: boolean }): CSSProperties {
    const style: CSSProperties & Record<`--${string}`, string> = {};

    if (direction === 'rtl') style['--animation-direction'] = 'reverse';
    if (typeof duration === 'number') style['--animation-duration'] = `${duration}s`;
    if (!enableAnimation) style['--pseudo-element-display'] = 'none';

    if (typeof width === 'string' || typeof width === 'number') style.width = width;
    if (typeof height === 'string' || typeof height === 'number') style.height = height;

    if (typeof borderRadius === 'string' || typeof borderRadius === 'number') style.borderRadius = borderRadius;

    if (circle) style.borderRadius = '50%';

    if (typeof baseColor !== 'undefined') style['--base-color'] = baseColor;
    if (typeof highlightColor !== 'undefined') style['--highlight-color'] = highlightColor;

    return style;
}

export interface SkeletonProps extends SkeletonStyleProps {
    count?: number;
    wrapper?: React.FunctionComponent<PropsWithChildren<unknown>>;
    className?: string;
    containerClassName?: string;
    containerTestId?: string;
    circle?: boolean;
}

export function Skeleton({
    count = 1,
    wrapper: Wrapper,
    className: customClassName,
    containerClassName,
    containerTestId,
    circle = false,
    ...originalPropsStyleOptions
}: SkeletonProps): ReactElement {
    const propsStyleOptions = { ...originalPropsStyleOptions };
    for (const [key, value] of Object.entries(originalPropsStyleOptions)) {
        if (typeof value === 'undefined') {
            delete propsStyleOptions[key as keyof typeof propsStyleOptions];
        }
    }
    const styleOptions = {
        ...propsStyleOptions,
        circle,
    };
    const style = styleOptionsToCssProperties(styleOptions);

    const inline = styleOptions.inline ?? false;
    const elements: ReactElement[] = [];
    const countCeil = Math.ceil(count);

    for (let i = 0; i < countCeil; i++) {
        let thisStyle = style;

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
        <span
            className={containerClassName}
            data-testid={containerTestId}
            aria-live="polite"
            aria-busy={styleOptions.enableAnimation ?? defaultEnableAnimation}
        >
            {Wrapper ? elements.map((el, i) => <Wrapper key={i}>{el}</Wrapper>) : elements}
        </span>
    );
}
