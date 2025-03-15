import * as React from 'react';

import { Overlay, OverlayProps, OverlayVisibility } from './overlay.js';
import { FocusTrapHookArgs, FocusZoneHookArgs, useFocusTrap, useFocusZone } from './focus.js';
import { PositionSettings, useAnchoredPosition } from './anchored_position.js';
import { useRenderForcingRef } from './rerender_ref.js';

interface AnchoredOverlayPropsWithAnchor {
    /// A custom function component used to render the anchor element.
    /// Will receive the selected text as `children` prop when an item is activated.
    renderAnchor: <T extends React.HTMLAttributes<HTMLElement>>(props: T) => JSX.Element
    /// An override to the internal ref that will be spread on to the renderAnchor
    anchorRef?: React.RefObject<HTMLElement>
    /// An override to the internal id that will be spread on to the renderAnchor
    anchorId?: string
}

interface AnchoredOverlayPropsWithoutAnchor {
    /// A custom function component used to render the anchor element.
    /// When renderAnchor is null, an anchorRef is required.
    renderAnchor: null
    /// An override to the internal renderAnchor ref that will be used to position the overlay.
    /// When renderAnchor is null this can be used to make an anchor that is detached from ActionMenu.
    anchorRef: React.RefObject<HTMLElement>
    /// An override to the internal id that will be spread on to the renderAnchor
    anchorId?: string
}

export type AnchoredOverlayWrapperAnchorProps =
    | Partial<AnchoredOverlayPropsWithAnchor>
    | AnchoredOverlayPropsWithoutAnchor

interface AnchoredOverlayBaseProps extends Pick<OverlayProps, 'height' | 'width'> {
    /// The React children
    children?: React.ReactElement;
    /// Determines whether the overlay portion of the component should be shown or not
    open: boolean;
    /// A callback which is called whenever the overlay is currently closed and an "open gesture" is detected.
    onOpen?: (gesture: 'anchor-click' | 'anchor-key-press', event?: React.KeyboardEvent<HTMLElement>) => unknown;
    /// A callback which is called whenever the overlay is currently open and a "close gesture" is detected.
    onClose?: (gesture: 'anchor-click' | 'click-outside' | 'escape') => unknown;
    /// Props to be spread on the internal `Overlay` component.
    overlayProps?: Partial<OverlayProps>;
    /// Settings to apply to the Focus Zone on the internal `Overlay` component.
    focusTrapSettings?: Partial<FocusTrapHookArgs>;
    /// Settings to apply to the Focus Zone on the internal `Overlay` component.
    focusZoneSettings?: Partial<FocusZoneHookArgs>;
}

export type AnchoredOverlayProps = AnchoredOverlayBaseProps &
    (AnchoredOverlayPropsWithAnchor | AnchoredOverlayPropsWithoutAnchor) &
    Partial<Pick<PositionSettings, 'align' | 'side' | 'anchorOffset' | 'alignmentOffset'>>

/// An `AnchoredOverlay` provides an anchor that will open a floating overlay positioned relative to the anchor.
/// The overlay can be opened and navigated using keyboard or mouse.
export function AnchoredOverlay(args: AnchoredOverlayProps) {
    const altAnchorRef = React.useRef<HTMLElement>(null);
    const anchorRef = args.anchorRef ?? altAnchorRef;
    const [overlayRef, updateOverlayRef] = useRenderForcingRef<HTMLDivElement>()
    const anchorId = React.useId()

    const onClickOutside = React.useCallback(() => args.onClose?.('click-outside'), [args.onClose])
    const onEscape = React.useCallback(() => args.onClose?.('escape'), [args.onClose])

    const onAnchorKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLElement>) => {
            if (!event.defaultPrevented) {
                if (!args.open && ['ArrowDown', 'ArrowUp', ' ', 'Enter'].includes(event.key)) {
                    args.onOpen?.('anchor-key-press', event)
                    event.preventDefault()
                }
            }
        },
        [args.open, args.onOpen],
    )
    const onAnchorClick = React.useCallback(
        (event: React.MouseEvent<HTMLElement>) => {
            if (event.defaultPrevented || event.button !== 0) {
                return
            }
            if (!args.open) {
                args.onOpen?.('anchor-click')
            } else {
                args.onClose?.('anchor-click')
            }
        },
        [args.open, args.onOpen, args.onClose],
    )

    const { position } = useAnchoredPosition({
        anchorElementRef: anchorRef,
        floatingElementRef: overlayRef,
        side: args.side,
        align: args.align,
        alignmentOffset: args.alignmentOffset,
        anchorOffset: args.anchorOffset,
    }, [overlayRef.current])

    React.useEffect(() => {
        // ensure overlay ref gets cleared when closed, so position can reset between closing/re-opening
        if (!args.open && overlayRef.current) {
            updateOverlayRef(null)
        }
    }, [args.open, overlayRef, updateOverlayRef])

    useFocusZone({
        containerRef: overlayRef,
        disabled: !args.open || !position,
        ...args.focusZoneSettings,
    })
    useFocusTrap({ containerRef: overlayRef, disabled: !args.open || !position, ...args.focusTrapSettings })

    return (
        <>
            {args.renderAnchor &&
                args.renderAnchor({
                    ref: anchorRef,
                    id: anchorId,
                    'aria-haspopup': 'true',
                    'aria-expanded': args.open,
                    tabIndex: 0,
                    onClick: onAnchorClick,
                    onKeyDown: onAnchorKeyDown,
                })}
            {args.open ? (
                <Overlay
                    ref={updateOverlayRef}
                    returnFocusRef={anchorRef}
                    onClickOutside={onClickOutside}
                    ignoreClickRefs={[anchorRef]}
                    onEscape={onEscape}
                    role="none"
                    visibility={position ? OverlayVisibility.Visible : OverlayVisibility.Hidden}
                    height={args.height}
                    width={args.width}
                    top={position?.top || 0}
                    left={position?.left || 0}
                    anchorSide={position?.anchorSide}
                    {...args.overlayProps}
                >
                    {args.children}
                </Overlay>
            ) : null}
        </>
    )
}
