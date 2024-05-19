import * as React from 'react';

import { classNames } from '../utils/classnames.js';

import * as styles from './spinners.module.css';

interface RectangleWaveSpinnerProps {
    className?: string;
    color?: string;
    active: boolean;
}

export const CenteredRectangleWaveSpinner: React.FC<RectangleWaveSpinnerProps> = (
    props: RectangleWaveSpinnerProps,
) => {
    return (
        <div className={styles.rw_container}>
            <RectangleWaveSpinner className={props.className} active={props.active} color={props.color} />
        </div>
    );
};

export const RectangleWaveSpinner: React.FC<RectangleWaveSpinnerProps> = (props: RectangleWaveSpinnerProps) => {
    const s = {
        backgroundColor: props.color || 'rgb(36, 41, 46)',
    };
    return (
        <div className={classNames(props.className, styles.rw)}>
            <div
                className={classNames(styles.rw_rect_1, {
                    [styles.rw_rect_active]: props.active,
                })}
                style={s}
            />
            <div
                className={classNames(styles.rw_rect_2, {
                    [styles.rw_rect_active]: props.active,
                })}
                style={s}
            />
            <div
                className={classNames(styles.rw_rect_3, {
                    [styles.rw_rect_active]: props.active,
                })}
                style={s}
            />
            <div
                className={classNames(styles.rw_rect_4, {
                    [styles.rw_rect_active]: props.active,
                })}
                style={s}
            />
            <div
                className={classNames(styles.rw_rect_5, {
                    [styles.rw_rect_active]: props.active,
                })}
                style={s}
            />
        </div>
    );
};
