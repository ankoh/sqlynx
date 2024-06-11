import * as React from "react";

import { Portal } from './portal.js';
import { classNames } from '../../utils/classnames.js';
import { useOpenAndCloseFocus } from './auto_focus.js';
import { useOnOutsideClick } from './outside_click.js';

import * as styles from './overlay.module.css';
import { useKeyEvents } from '../../utils/key_events.js';

interface UseOverlayArgs {
    ignoreClickRefs?: React.RefObject<HTMLElement>[];
    initialFocusRef?: React.RefObject<HTMLElement>;
    returnFocusRef: React.RefObject<HTMLElement>;
    onEscape: (e: KeyboardEvent) => void;
    onClickOutside: (e: TouchEvent | MouseEvent) => void;
    overlayRef?: React.RefObject<HTMLDivElement>;
    preventFocusOnOpen?: boolean;
}

export function useOverlay(args: UseOverlayArgs): React.RefObject<HTMLDivElement> {
    const ownOverlayRef = React.useRef<HTMLDivElement>(null);
    const overlayRef = args.overlayRef ?? ownOverlayRef;
    useOpenAndCloseFocus({containerRef: overlayRef, returnFocusRef: args.returnFocusRef, initialFocusRef: args.initialFocusRef, preventFocusOnOpen: args.preventFocusOnOpen});
    useOnOutsideClick({containerRef: overlayRef, ignoreClickRefs: args.ignoreClickRefs, onClickOutside: args.onClickOutside})
    useKeyEvents([
        {
            key: "Escape",
            ctrlKey: false,
            callback: (e: KeyboardEvent) => {
                args.onEscape(e);
                e.preventDefault();
            }
        }
    ]);
    return overlayRef;
}

export enum OverlaySize {
    UNSPECIFIED,
    AUTO,
    XS,
    S,
    M,
    L,
    XL,
    XXL,
}

const HEIGHT_STYLES: (string | null)[] = [
    null,
    styles.height_auto,
    styles.height_xs,
    styles.height_s,
    styles.height_m,
    styles.height_l,
    styles.height_xl,
    null,
];
const MAX_HEIGHT_STYLES: (string | null)[] = [
    null,
    null,
    styles.max_height_xs,
    styles.max_height_s,
    styles.max_height_m,
    styles.max_height_l,
    styles.max_height_xl,
    null,
];

const WIDTH_STYLES: (string | null)[] = [
    null,
    styles.width_auto,
    null,
    styles.width_s,
    styles.width_m,
    styles.width_l,
    styles.width_xl,
    styles.width_xxl,
];
const MAX_WIDTH_STYLES: (string | null)[] = [
    null,
    null,
    null,
    styles.max_width_s,
    styles.max_width_m,
    styles.max_width_l,
    styles.max_width_xl,
    styles.max_width_xxl,
];

export enum OverlayAnchorSide {
    Top,
    Right,
    Bottom,
    Left,
}

export enum OverlayVisibility {
    Hidden,
    Visible
}

function getSlideAnimationStartingVector(anchorSide?: OverlayAnchorSide): {x: number; y: number} {
    switch (anchorSide) {
        case OverlayAnchorSide.Top:
            return {x: 0, y: 1};
        case OverlayAnchorSide.Right:
            return {x: -1, y: 0};
        case OverlayAnchorSide.Left:
            return {x: 1, y: 0};
        case OverlayAnchorSide.Bottom:
            return {x: 0, y: -1};
    }
    return {x: 0, y: 0}
}

interface Props {
    ignoreClickRefs?: React.RefObject<HTMLElement>[];
    initialFocusRef?: React.RefObject<HTMLElement>;
    returnFocusRef: React.RefObject<HTMLElement>;
    onClickOutside: (e: MouseEvent | TouchEvent) => void;
    onEscape: (e: KeyboardEvent) => void;
    visibility?: OverlayVisibility;
    preventFocusOnOpen?: boolean;
    portalContainerName: string;
    width?: OverlaySize;
    height?: OverlaySize;
    maxWidth?: OverlaySize;
    maxHeight?: OverlaySize;
    anchorSide?: OverlayAnchorSide;
    children?: React.ReactNode;
}

const SLIDE_ANIMATION_DISTANCE = 8;

export function Overlay(props: Props) {
    const width = WIDTH_STYLES[props.width ?? OverlaySize.UNSPECIFIED];
    const height = props.height ? HEIGHT_STYLES[props.height] : null;
    const maxWidth = props.maxWidth ? MAX_WIDTH_STYLES[props.maxWidth] : null;
    const maxHeight = props.maxHeight ? MAX_HEIGHT_STYLES[props.maxHeight] : null;

    const overlayRef = useOverlay({
        returnFocusRef: props.returnFocusRef,
        onEscape: props.onEscape,
        ignoreClickRefs: props.ignoreClickRefs,
        onClickOutside: props.onClickOutside,
        initialFocusRef: props.initialFocusRef,
        preventFocusOnOpen: props.preventFocusOnOpen,
    });

    // JS animation is required because Safari does not allow css animations to start paused and then run
    React.useLayoutEffect(() => {
        const {x, y} = getSlideAnimationStartingVector(props.anchorSide)
        if ((!x && !y) || !overlayRef.current?.animate || props.visibility === OverlayVisibility.Hidden) {
            return
        }
        overlayRef.current.animate(
            {transform: [`translate(${SLIDE_ANIMATION_DISTANCE * x}px, ${SLIDE_ANIMATION_DISTANCE * y}px)`, `translate(0, 0)`]},
            {
                duration: "200ms",
                easing: "cubic-bezier(0.33, 1, 0.68, 1)",
            },
        )
    }, [props.anchorSide, props.visibility])

    return (
        <Portal containerName={props.portalContainerName}>
            <div className={classNames(styles.overlay, width, height, maxWidth, maxHeight)}>

            </div>
        </Portal>
    );
}