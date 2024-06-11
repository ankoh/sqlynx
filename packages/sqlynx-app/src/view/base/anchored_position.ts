import * as React from 'react';
import { observeSize } from './size_observer.js';

export enum AnchorAlignment {
    Start,
    Center,
    End
}

export enum AnchorSide {
    InsideTop = 0 << 1,
    InsideBottom = 1 << 1,
    InsideLeft = 2 << 1,
    InsideRight = 3 << 1,

    InsideCenter = 4 << 1,

    OutsideTop =  (5 << 1) | 0b1,
    OutsideBottom = (6 << 1) | 0b1,
    OutsideLeft = (7 << 1) | 0b1,
    OutsideRight = (8 << 1) | 0b1,
}

function isInsideAnchorSide(side: AnchorSide) { return (side & 0b1) == 0; }

export interface PositionSettings {
    /// Sets the side of the anchor element that the floating element should be
    /// pinned to. This side is given by a string starting with either "inside" or
    /// "outside", followed by a hyphen, followed by either "top", "right", "bottom",
    /// or "left". Additionally, "inside-center" is an allowed value.
    ///
    /// The first part of this string, "inside" or "outside", determines whether the
    /// floating element should be attempted to be placed "inside" the anchor element
    /// or "outside" of it. Using "inside" is useful for making it appear that the
    /// anchor _contains_ the floating element, and it can be used for implementing a
    /// dialog that is centered on the screen. The "outside" value is more common and
    /// can be used for tooltips, popovers, menus, etc.
    ///
    /// The second part of this string determines the _edge_ on the anchor element that
    /// the floating element will be anchored to. If side is "inside-center", then
    /// the floating element will be centered in the X-direction (while align is used
    /// to position it in the Y-direction).
    /// Note: "outside-center" is _not_ a valid value for this property.
    side: AnchorSide;
    /// Determines how the floating element should align with the anchor element. If
    /// set to "start", the floating element's first edge (top or left) will align
    /// with the anchor element's first edge. If set to "center", the floating
    /// element will be centered along the axis of the anchor edge. If set to "end",
    /// the floating element's last edge will align with the anchor element's last edge.
    align: AnchorAlignment;
    ///  The number of pixels between the anchor edge and the floating element.
    ///
    ///  Positive values move the floating element farther from the anchor element
    ///  (for outside positioning) or further inside the anchor element (for inside
    ///  positioning). Negative values have the opposite effect.
    anchorOffset: number;
    /// An additional offset, in pixels, to move the floating element from
    /// the aligning edge.
    ///
    /// Positive values move the floating element in the direction of center-
    /// alignment. Negative values move the floating element away from center-
    /// alignment. When align is "center", positive offsets move the floating
    /// element right (top or bottom anchor side) or down (left or right
    /// anchor side).
    alignmentOffset: number;
    /// If false, when the above settings result in rendering the floating element
    /// wholly or partially outside of the bounds of the containing element, attempt
    /// to adjust the settings to prevent this. Only applies to "outside" positioning.
    ///
    /// First, attempt to flip to the opposite edge of the anchor if the floating
    /// element is getting clipped in that direction. If flipping results in a
    /// similar clipping, try moving to the adjacent sides.
    ///
    /// Once we find a side that does not clip the overlay in its own dimension,
    /// check the rest of the sides to see if we need to adjust the alignment offset
    /// to fit in other dimensions.
    ///
    /// If we try all four sides and get clipped each time, settle for overflowing
    /// and use the "bottom" side, since the ability to scroll is most likely in
    /// this direction.
    allowOutOfBounds: boolean;
}

/// For each outside anchor position, list the order of alternate positions to try in
/// the event that the original position overflows. See comment on `allowOutOfBounds`
/// for a more detailed description.
const alternateOrders: Partial<Record<AnchorSide, [AnchorSide, AnchorSide, AnchorSide, AnchorSide]>> = {
    [AnchorSide.OutsideTop]: [AnchorSide.OutsideBottom, AnchorSide.OutsideRight, AnchorSide.OutsideLeft, AnchorSide.OutsideBottom],
    [AnchorSide.OutsideBottom]: [AnchorSide.OutsideTop, AnchorSide.OutsideRight, AnchorSide.OutsideLeft, AnchorSide.OutsideBottom],
    [AnchorSide.OutsideLeft]: [AnchorSide.OutsideRight, AnchorSide.OutsideBottom, AnchorSide.OutsideTop, AnchorSide.OutsideBottom],
    [AnchorSide.OutsideRight]: [AnchorSide.OutsideLeft, AnchorSide.OutsideBottom, AnchorSide.OutsideTop, AnchorSide.OutsideBottom],
}

/// For each alignment, list the order of alternate alignments to try in
/// the event that the original position overflows.
/// Prefer start or end over center.
const alternateAlignments: Partial<Record<AnchorAlignment, [AnchorAlignment, AnchorAlignment]>> = {
    [AnchorAlignment.Start]: [AnchorAlignment.End, AnchorAlignment.Center],
    [AnchorAlignment.End]: [AnchorAlignment.Start, AnchorAlignment.Start],
    [AnchorAlignment.Center]: [AnchorAlignment.End, AnchorAlignment.Start],
}

interface Size {
    width: number
    height: number
}

interface Position {
    top: number
    left: number
}

export interface AnchorPosition {
    top: number
    left: number
    anchorSide: AnchorSide
    anchorAlign: AnchorAlignment
}

interface BoxPosition extends Size, Position {}

/// Given a floating element and an anchor element, return coordinates for the top-left
/// of the floating element in order to absolutely position it such that it appears
/// near the anchor element.
export function getAnchoredPosition(
    floatingElement: Element,
    anchorElement: Element | DOMRect,
    settings: Partial<PositionSettings> = {},
): AnchorPosition {
    const parentElement = getPositionedParent(floatingElement)
    const clippingRect = getClippingRect(parentElement)

    const parentElementStyle = getComputedStyle(parentElement)
    const parentElementRect = parentElement.getBoundingClientRect()
    const [borderTop, borderLeft] = [parentElementStyle.borderTopWidth, parentElementStyle.borderLeftWidth].map(
        v => parseInt(v, 10) || 0,
    )
    const relativeRect = {
        top: parentElementRect.top + borderTop,
        left: parentElementRect.left + borderLeft,
    }

    return pureCalculateAnchoredPosition(
        clippingRect,
        relativeRect,
        floatingElement.getBoundingClientRect(),
        anchorElement instanceof Element ? anchorElement.getBoundingClientRect() : anchorElement,
        getDefaultSettings(settings),
    )
}

/// Returns the nearest proper HTMLElement parent of `element` whose
/// position is not "static", or document.body, whichever is closer
function getPositionedParent(element: Element) {
    if (isOnTopLayer(element)) return document.body
    let parentNode = element.parentNode
    while (parentNode !== null) {
        if (parentNode instanceof HTMLElement && getComputedStyle(parentNode).position !== 'static') {
            return parentNode
        }
        parentNode = parentNode.parentNode
    }
    return document.body
}

/// Returns true if the element is likely to be on the `top-layer`.
function isOnTopLayer(element: Element) {
    if (element.tagName === 'DIALOG') {
        return true
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (element.matches(':popover-open') && /native code/.test((document.body as any).showPopover?.toString())) {
            return true
        }
    } catch {
        return false
    }
    return false
}

/// Returns the rectangle (relative to the window) that will clip the given element
/// if it is rendered outside of its bounds.
function getClippingRect(element: Element): BoxPosition {
    let parentNode: typeof element.parentNode = element
    while (parentNode !== null) {
        if (!(parentNode instanceof Element)) {
            break
        }
        const parentNodeStyle = getComputedStyle(parentNode as Element)
        if (parentNodeStyle.overflow !== 'visible') {
            break
        }
        parentNode = parentNode.parentNode
    }
    const clippingNode = parentNode === document.body || !(parentNode instanceof HTMLElement) ? document.body : parentNode

    const elemRect = clippingNode.getBoundingClientRect()
    const elemStyle = getComputedStyle(clippingNode)

    const [borderTop, borderLeft, borderRight, borderBottom] = [
        elemStyle.borderTopWidth,
        elemStyle.borderLeftWidth,
        elemStyle.borderRightWidth,
        elemStyle.borderBottomWidth,
    ].map(v => parseInt(v, 10) || 0)

    return {
        top: elemRect.top + borderTop,
        left: elemRect.left + borderLeft,
        width: elemRect.width - borderRight - borderLeft,

        // If the clipping node is document.body, it can expand to the full height of the window
        height: Math.max(
            elemRect.height - borderTop - borderBottom,
            clippingNode === document.body ? window.innerHeight : -Infinity,
        ),
    }
}

// Default settings to position a floating element
const positionDefaults: PositionSettings = {
    side: AnchorSide.OutsideBottom,
    align: AnchorAlignment.Start,

    // note: the following default is not applied if side === "inside-center"
    anchorOffset: 4,

    // note: the following default is only applied if side starts with "inside"
    // and align is not center
    alignmentOffset: 4,

    allowOutOfBounds: false,
}

/// Compute a full PositionSettings object from the given partial PositionSettings object
/// by filling in with defaults where applicable.
function getDefaultSettings(settings: Partial<PositionSettings> = {}): PositionSettings {
    const side = settings.side ?? positionDefaults.side
    const align = settings.align ?? positionDefaults.align
    return {
        side,
        align,
        // offsets always default to 0 if their respective side/alignment is centered
        anchorOffset: settings.anchorOffset ?? (side === AnchorSide.InsideCenter ? 0 : positionDefaults.anchorOffset),
        alignmentOffset:
            settings.alignmentOffset ??
            (align !== AnchorAlignment.Center &&  isInsideAnchorSide(side) ? positionDefaults.alignmentOffset : 0),
        allowOutOfBounds: settings.allowOutOfBounds ?? positionDefaults.allowOutOfBounds,
    }
}

/// Note: This is a pure function with no dependency on DOM APIs.
function pureCalculateAnchoredPosition(
    viewportRect: BoxPosition,
    relativePosition: Position,
    floatingRect: Size,
    anchorRect: BoxPosition,
    {side, align, allowOutOfBounds, anchorOffset, alignmentOffset}: PositionSettings,
): AnchorPosition {
    // Compute the relative viewport rect, to bring it into the same coordinate space as `pos`
    const relativeViewportRect: BoxPosition = {
        top: viewportRect.top - relativePosition.top,
        left: viewportRect.left - relativePosition.left,
        width: viewportRect.width,
        height: viewportRect.height,
    }

    let pos = calculatePosition(floatingRect, anchorRect, side, align, anchorOffset, alignmentOffset)
    let anchorSide = side
    let anchorAlign = align
    pos.top -= relativePosition.top
    pos.left -= relativePosition.left

    // Handle screen overflow
    if (!allowOutOfBounds) {
        const alternateOrder = alternateOrders[side]

        let positionAttempt = 0
        if (alternateOrder) {
            let prevSide = side

            // Try all the alternate sides until one does not overflow
            while (
                positionAttempt < alternateOrder.length &&
                shouldRecalculatePosition(prevSide, pos, relativeViewportRect, floatingRect)
                ) {
                const nextSide = alternateOrder[positionAttempt++]
                prevSide = nextSide

                // If we have cut off in the same dimension as the "side" option, try flipping to the opposite side.
                pos = calculatePosition(floatingRect, anchorRect, nextSide, align, anchorOffset, alignmentOffset)
                pos.top -= relativePosition.top
                pos.left -= relativePosition.left
                anchorSide = nextSide
            }
        }

        // If using alternate anchor side does not stop overflow,
        // try using an alternate alignment
        const alternateAlignment = alternateAlignments[align]

        let alignmentAttempt = 0
        if (alternateAlignment) {
            let prevAlign = align

            // Try all the alternate alignments until one does not overflow
            while (
                alignmentAttempt < alternateAlignment.length &&
                shouldRecalculateAlignment(prevAlign, pos, relativeViewportRect, floatingRect)
                ) {
                const nextAlign = alternateAlignment[alignmentAttempt++]
                prevAlign = nextAlign

                pos = calculatePosition(floatingRect, anchorRect, anchorSide, nextAlign, anchorOffset, alignmentOffset)
                pos.top -= relativePosition.top
                pos.left -= relativePosition.left
                anchorAlign = nextAlign
            }
        }

        // At this point we've flipped the position if applicable. Now just nudge until it's on-screen.
        if (pos.top < relativeViewportRect.top) {
            pos.top = relativeViewportRect.top
        }
        if (pos.left < relativeViewportRect.left) {
            pos.left = relativeViewportRect.left
        }
        if (pos.left + floatingRect.width > viewportRect.width + relativeViewportRect.left) {
            pos.left = viewportRect.width + relativeViewportRect.left - floatingRect.width
        }
        // If we have exhausted all possible positions and none of them worked, we
        // say that overflowing the bottom of the screen is acceptable since it is
        // likely to be able to scroll.
        if (alternateOrder && positionAttempt < alternateOrder.length) {
            if (pos.top + floatingRect.height > viewportRect.height + relativeViewportRect.top) {
                // This prevents top from being a negative value
                pos.top = Math.max(viewportRect.height + relativeViewportRect.top - floatingRect.height, 0)
            }
        }
    }

    return {...pos, anchorSide, anchorAlign}
}

/// Given a floating element and an anchor element, return coordinates for the
/// top-left of the floating element in order to absolutely position it such
/// that it appears near the anchor element.
function calculatePosition(
    elementDimensions: Size,
    anchorPosition: BoxPosition,
    side: AnchorSide,
    align: AnchorAlignment,
    anchorOffset: number,
    alignmentOffset: number,
) {
    const anchorRight = anchorPosition.left + anchorPosition.width
    const anchorBottom = anchorPosition.top + anchorPosition.height
    let top = -1
    let left = -1
    if (side === AnchorSide.OutsideTop) {
        top = anchorPosition.top - anchorOffset - elementDimensions.height
    } else if (side === AnchorSide.OutsideBottom) {
        top = anchorBottom + anchorOffset
    } else if (side === AnchorSide.OutsideLeft) {
        left = anchorPosition.left - anchorOffset - elementDimensions.width
    } else if (side === AnchorSide.OutsideRight) {
        left = anchorRight + anchorOffset
    }

    if (side === AnchorSide.OutsideTop || side === AnchorSide.OutsideBottom) {
        if (align === AnchorAlignment.Start) {
            left = anchorPosition.left + alignmentOffset
        } else if (align === AnchorAlignment.Center) {
            left = anchorPosition.left - (elementDimensions.width - anchorPosition.width) / 2 + alignmentOffset
        } else {
            // end
            left = anchorRight - elementDimensions.width - alignmentOffset
        }
    }

    if (side === AnchorSide.OutsideLeft || side === AnchorSide.OutsideRight) {
        if (align === AnchorAlignment.Start) {
            top = anchorPosition.top + alignmentOffset
        } else if (align === AnchorAlignment.Center) {
            top = anchorPosition.top - (elementDimensions.height - anchorPosition.height) / 2 + alignmentOffset
        } else {
            // end
            top = anchorBottom - elementDimensions.height - alignmentOffset
        }
    }

    if (side === AnchorSide.InsideTop) {
        top = anchorPosition.top + anchorOffset
    } else if (side === AnchorSide.InsideBottom) {
        top = anchorBottom - anchorOffset - elementDimensions.height
    } else if (side === AnchorSide.InsideLeft) {
        left = anchorPosition.left + anchorOffset
    } else if (side === AnchorSide.InsideRight) {
        left = anchorRight - anchorOffset - elementDimensions.width
    } else if (side === AnchorSide.InsideCenter) {
        left = (anchorRight + anchorPosition.left) / 2 - elementDimensions.width / 2 + anchorOffset
    }

    if (side === AnchorSide.InsideTop || side === AnchorSide.InsideBottom) {
        if (align === AnchorAlignment.Start) {
            left = anchorPosition.left + alignmentOffset
        } else if (align === AnchorAlignment.Center) {
            left = anchorPosition.left - (elementDimensions.width - anchorPosition.width) / 2 + alignmentOffset
        } else {
            // end
            left = anchorRight - elementDimensions.width - alignmentOffset
        }
    } else if (side === AnchorSide.InsideLeft || side === AnchorSide.InsideRight || side === AnchorSide.InsideCenter) {
        if (align === AnchorAlignment.Start) {
            top = anchorPosition.top + alignmentOffset
        } else if (align === AnchorAlignment.Center) {
            top = anchorPosition.top - (elementDimensions.height - anchorPosition.height) / 2 + alignmentOffset
        } else {
            // end
            top = anchorBottom - elementDimensions.height - alignmentOffset
        }
    }

    return {top, left}
}

/// Determines if there is an overflow
function shouldRecalculatePosition(
    side: AnchorSide,
    currentPos: Position,
    containerDimensions: BoxPosition,
    elementDimensions: Size,
) {
    if (side === AnchorSide.OutsideTop || AnchorSide.OutsideBottom) {
        return (
            currentPos.top < containerDimensions.top ||
            currentPos.top + elementDimensions.height > containerDimensions.height + containerDimensions.top
        )
    } else {
        return (
            currentPos.left < containerDimensions.left ||
            currentPos.left + elementDimensions.width > containerDimensions.width + containerDimensions.left
        )
    }
}

/// Determines if there is an overflow
function shouldRecalculateAlignment(
    align: AnchorAlignment,
    currentPos: Position,
    containerDimensions: BoxPosition,
    elementDimensions: Size,
) {
    if (align === AnchorAlignment.End) {
        return currentPos.left < containerDimensions.left
    } else if (align === AnchorAlignment.Start || align === AnchorAlignment.Center) {
        return (
            // right edge
            currentPos.left + elementDimensions.width > containerDimensions.left + containerDimensions.width ||
            // left edge
            currentPos.left < containerDimensions.left
        )
    }
}

export interface AnchoredPositionHookArgs extends Partial<PositionSettings> {
    floatingElementRef?: React.RefObject<Element>
    anchorElementRef?: React.RefObject<Element>
}

export function useAnchoredPosition(args?: AnchoredPositionHookArgs, dependencies: React.DependencyList = []): {
    floatingElementRef: React.RefObject<Element>
    anchorElementRef: React.RefObject<Element>
    position: AnchorPosition | undefined
} {
    const altFloatingElementRef = React.useRef<Element>(null);
    const altAnchorElementRef = React.useRef<Element>(null);

    const floatingElementRef = args?.floatingElementRef ?? altFloatingElementRef;
    const anchorElementRef = args?.anchorElementRef ?? altAnchorElementRef;
    const [position, setPosition] = React.useState<AnchorPosition | undefined>(undefined)

    const windowElem = React.useRef(document.documentElement);
    const windowSize = observeSize(windowElem);

    // Update the anchored position whenever the window resizes
    React.useLayoutEffect(() => {
        if (floatingElementRef.current instanceof Element && anchorElementRef.current instanceof Element) {
            setPosition(getAnchoredPosition(floatingElementRef.current, anchorElementRef.current, args))
        } else {
            setPosition(undefined)
        }
    }, [windowSize, ...dependencies]);

    return {
        floatingElementRef,
        anchorElementRef,
        position,
    }
}
