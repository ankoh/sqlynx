import * as React from 'react';
import * as styles from './tooltip.module.css';

import { KeyEventHandler, useKeyEvents } from '../../utils/key_events.js';
import { AnchorAlignment, AnchorSide, getAnchoredPosition } from './anchored_position.js';

export type TriggerPropsType = {
    'aria-describedby'?: string
    'aria-labelledby'?: string
    'aria-label'?: string
    onBlur?: React.FocusEventHandler
    onFocus?: React.FocusEventHandler
    onMouseEnter?: React.MouseEventHandler
    onMouseLeave?: React.MouseEventHandler
    ref?: React.RefObject<HTMLElement>
}

export type TooltipDirection = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export interface TooltipProps {
    direction?: TooltipDirection;
    text: string
    type?: 'label' | 'description'
    children?: React.ReactElement<TriggerPropsType>;
}

const directionToPosition: Record<TooltipDirection, {side: AnchorSide; align: AnchorAlignment}> = {
    nw: { side: AnchorSide.OutsideTop, align: AnchorAlignment.End },
    n: { side: AnchorSide.OutsideTop, align: AnchorAlignment.Center },
    ne: { side: AnchorSide.OutsideTop, align: AnchorAlignment.Start },
    e: { side: AnchorSide.OutsideRight, align: AnchorAlignment.Center },
    se: { side: AnchorSide.OutsideBottom, align: AnchorAlignment.Start },
    s: { side: AnchorSide.OutsideBottom, align: AnchorAlignment.Center },
    sw: { side: AnchorSide.OutsideBottom, align: AnchorAlignment.End },
    w: { side: AnchorSide.OutsideLeft, align: AnchorAlignment.Center },
}

const positionToDirection: Record<number, TooltipDirection> = {
    [(AnchorSide.OutsideTop << 3 | AnchorAlignment.End)]: 'nw',
    [(AnchorSide.OutsideTop << 3 | AnchorAlignment.Center)]: 'n',
    [(AnchorSide.OutsideTop << 3 | AnchorAlignment.Start)]: 'ne',
    [(AnchorSide.OutsideRight << 3 | AnchorAlignment.Center)]: 'e',
    [(AnchorSide.OutsideBottom << 3 | AnchorAlignment.Start)]: 'se',
    [(AnchorSide.OutsideBottom << 3 | AnchorAlignment.Center)]: 's',
    [(AnchorSide.OutsideBottom << 3 | AnchorAlignment.End)]: 'sw',
    [(AnchorSide.OutsideLeft << 3 | AnchorAlignment.Center)]: 'w',
}

export const TooltipContext = React.createContext<{tooltipId?: string}>({})

export function Tooltip(props: TooltipProps): React.ReactElement  {
    const tooltipId = React.useId()
    const triggerRef = React.useRef<HTMLElement>(null);
    const tooltipElRef = React.useRef<HTMLDivElement>(null)
    const [calculatedDirection, setCalculatedDirection] = React.useState<TooltipDirection | undefined>(props.direction)
    const isPopOverOpen = React.useRef(false);

    const openTooltip = () => {
        if (
            tooltipElRef.current &&
            triggerRef.current &&
            tooltipElRef.current.hasAttribute('popover') &&
            !tooltipElRef.current.matches(':popover-open')
        ) {
            const tooltip = tooltipElRef.current
            const trigger = triggerRef.current
            tooltip.showPopover()
            isPopOverOpen.current = true;

            const settings = props.direction ? directionToPosition[props.direction] : undefined;
            const {top, left, anchorAlign, anchorSide} = getAnchoredPosition(tooltip, trigger, settings)
            const calculatedDirection = positionToDirection[(anchorSide << 3) | anchorAlign];
            setCalculatedDirection(calculatedDirection);
            tooltip.style.top = `${top}px`
            tooltip.style.left = `${left}px`
        }
    }
    // Helper to close a tooltip
    const closeTooltip = () => {
        if (
            tooltipElRef.current &&
            triggerRef.current &&
            tooltipElRef.current.hasAttribute('popover') &&
            tooltipElRef.current.matches(':popover-open')
        ) {
            tooltipElRef.current.hidePopover()
            isPopOverOpen.current = false;
        }
    }
    // context value
    const value = React.useMemo(() => ({tooltipId}), [tooltipId])

    React.useEffect(() => {
        if (!tooltipElRef.current || !triggerRef.current) return

        // If the tooltip is used for labelling the interactive element, the trigger element or any of its children should not have aria-label
        if (props.type === 'label') {
            const hasAriaLabel = triggerRef.current.hasAttribute('aria-label')
            const hasAriaLabelInChildren = Array.from(triggerRef.current.childNodes).some(
                child => child instanceof HTMLElement && child.hasAttribute('aria-label'),
            )
            if (hasAriaLabel || hasAriaLabelInChildren) {
                console.warn(
                    'The label type `Tooltip` is going to be used here to label the trigger element. Please remove the aria-label from the trigger element.',
                );
            }
        }
        const tooltip = tooltipElRef.current
        tooltip.setAttribute('popover', 'auto')
    }, [tooltipElRef, triggerRef, props.direction, props.type])


    // Setup handler to close the tooltip with escape
    const keyEvents = React.useMemo<KeyEventHandler[]>(() => ([{
        key: "Escape",
        ctrlKey: false,
        callback: (event: KeyboardEvent) => {
            if (isPopOverOpen.current) {
                event.stopImmediatePropagation()
                event.preventDefault()
                closeTooltip()
            }
        }
    }]), []);
    useKeyEvents(keyEvents);

    const child = props.children;
    return (
        <TooltipContext.Provider value={value}>
            <>
                {child &&
                    React.cloneElement(child, {
                        ref: triggerRef,
                        // If it is a type description, we use tooltip to describe the trigger
                        'aria-describedby': props.type === 'description' ? tooltipId : child.props['aria-describedby'],
                        // If it is a label type, we use tooltip to label the trigger
                        'aria-labelledby': props.type === 'label' ? tooltipId : child.props['aria-labelledby'],
                        onBlur: (event: React.FocusEvent) => {
                            closeTooltip()
                            child.props.onBlur?.(event)
                        },
                        onFocus: (event: React.FocusEvent) => {
                            // only show tooltip on :focus-visible, not on :focus
                            try {
                                if (!event.target.matches(':focus-visible')) return
                            } catch (error) {
                                // jsdom (jest) does not support `:focus-visible` yet and would throw an error
                                // https://github.com/jsdom/jsdom/issues/3426
                            }
                            openTooltip()
                            child.props.onFocus?.(event)
                        },
                        onMouseEnter: (event: React.MouseEvent) => {
                            openTooltip()
                            child.props.onMouseEnter?.(event)
                        },
                        onMouseLeave: (event: React.MouseEvent) => {
                            closeTooltip()
                            child.props.onMouseLeave?.(event)
                        },
                    })
                }
                <div
                    className={styles.tooltip}
                    ref={tooltipElRef}
                    data-direction={calculatedDirection}

                    role={props.type === 'description' ? 'tooltip' : undefined}
                    aria-hidden={props.type === 'label' ? true : undefined}
                    id={tooltipId}

                    onMouseEnter={openTooltip}
                    onMouseLeave={closeTooltip}
                >
                    {props.text}
                </div>
            </>
        </TooltipContext.Provider>
    );
}