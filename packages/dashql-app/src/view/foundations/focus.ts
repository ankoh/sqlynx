import * as React from 'react'
import { iterateFocusableElements } from '@primer/behaviors/utils'
import { focusTrap, focusZone, FocusZoneSettings } from '@primer/behaviors';

export type UseOpenAndCloseFocusArgs = {
    initialFocusRef?: React.RefObject<HTMLElement>
    containerRef: React.RefObject<HTMLElement>
    returnFocusRef: React.RefObject<HTMLElement>
    preventFocusOnOpen?: boolean
}

export function useOpenAndCloseFocus(args: UseOpenAndCloseFocusArgs): void {
    React.useEffect(() => {
        if (args.preventFocusOnOpen) {
            return;
        }
        const returnRef = args.returnFocusRef.current
        if (args.initialFocusRef && args.initialFocusRef.current) {
            args.initialFocusRef.current.focus()
        } else if (args.containerRef.current) {
            const firstItem = iterateFocusableElements(args.containerRef.current).next().value
            firstItem?.focus()
        }
        return function () {
            returnRef?.focus()
        }
    }, [args.initialFocusRef, args.returnFocusRef, args.containerRef, args.preventFocusOnOpen])
}


export interface FocusTrapHookArgs {
    /// Ref that will be used for the trapping container. If not provided, one will
    /// be created by this hook and returned.
    containerRef?: React.RefObject<HTMLElement>
    /// Ref for the element that should receive focus when the focus trap is first enabled. If
    /// not provided, one will be created by this hook and returned. Its use is optional.
    initialFocusRef?: React.RefObject<HTMLElement>
    /// Set to true to disable the focus trap and clean up listeners. Can be re-enabled at
    /// any time.
    disabled?: boolean
    /// If true, when this focus trap is cleaned up, restore focus to the element that had
    /// focus immediately before the focus trap was enabled. (Default: false)
    restoreFocusOnCleanUp?: boolean
    /// If passed, when this focus trap is cleaned up, restore focus to this element instead
    /// of element with focus immediately before the focus trap was enabled.
    returnFocusRef?: React.RefObject<HTMLElement>
}

/// Hook used to trap focus inside a container.
/// Returns a ref that can be added to the container that should trap focus.
export function useFocusTrap(
    args?: FocusTrapHookArgs,
    dependencies: React.DependencyList = [],
): {containerRef: React.RefObject<HTMLElement>; initialFocusRef: React.RefObject<HTMLElement>} {
    const altContainerRef = React.useRef<HTMLElement>(null);
    const altInitialFocusRef = React.useRef<HTMLElement>(null);

    const containerRef = args?.containerRef ?? altContainerRef
    const initialFocusRef = args?.initialFocusRef ?? altInitialFocusRef
    const disabled = args?.disabled
    const abortController = React.useRef<AbortController>()
    const previousFocusedElement = React.useRef<Element | null>(null)

    // If we are enabling a focus trap and haven't already stored the previously focused element
    // go ahead an do that so we can restore later when the trap is disabled.
    if (!previousFocusedElement.current && !args?.disabled) {
        previousFocusedElement.current = document.activeElement
    }
    // This function removes the event listeners that enable the focus trap and restores focus
    // to the previously-focused element (if necessary).
    function disableTrap() {
        abortController.current?.abort()
        if (args?.returnFocusRef && args.returnFocusRef.current instanceof HTMLElement) {
            args.returnFocusRef.current.focus()
        } else if (args?.restoreFocusOnCleanUp && previousFocusedElement.current instanceof HTMLElement) {
            previousFocusedElement.current.focus()
            previousFocusedElement.current = null
        }
    }

    React.useEffect(
        () => {
            if (containerRef.current instanceof HTMLElement) {
                if (!disabled) {
                    abortController.current = focusTrap(containerRef.current, initialFocusRef.current ?? undefined)
                    return () => {
                        disableTrap()
                    }
                } else {
                    disableTrap()
                }
            }
        },
        [containerRef, initialFocusRef, disabled, ...dependencies],
    )
    return {containerRef, initialFocusRef}
}


export interface FocusZoneHookArgs extends Omit<FocusZoneSettings, 'activeDescendantControl'> {
    /// Optional ref for the container that holds all elements participating in arrow key focus.
    /// If one is not passed, we will create one for you and return it from the hook.
    containerRef?: React.RefObject<HTMLElement>
    /// If using the "active descendant" focus pattern, pass `true` or a ref to the controlling
    /// element. If a ref object is not passed, we will create one for you.
    activeDescendantFocus?: boolean | React.RefObject<HTMLElement>
    /// Set to true to disable the focus zone and clean up listeners. Can be re-enabled at any time.
    disabled?: boolean
}

export function useFocusZone(
    settings: FocusZoneHookArgs = {},
    dependencies: React.DependencyList = [],
): { containerRef: React.RefObject<HTMLElement>; activeDescendantControlRef: React.RefObject<HTMLElement> } {
    const altContainerRef = React.useRef<HTMLElement>(null);
    const altActiveDescFocusRef = React.useRef<HTMLElement>(null);

    const containerRef = settings.containerRef ?? altContainerRef;
    const useActiveDescendant = !!settings.activeDescendantFocus
    const passedActiveDescendantRef =
        typeof settings.activeDescendantFocus === 'boolean' || !settings.activeDescendantFocus
            ? undefined
            : settings.activeDescendantFocus
    const activeDescendantControlRef = passedActiveDescendantRef ?? altActiveDescFocusRef;
    const disabled = settings.disabled
    const abortController = React.useRef<AbortController>()

    React.useEffect(
        () => {
            if (
                containerRef.current instanceof HTMLElement &&
                (!useActiveDescendant || activeDescendantControlRef.current instanceof HTMLElement)
            ) {
                if (!disabled) {
                    const vanillaSettings: FocusZoneSettings = {
                        ...settings,
                        activeDescendantControl: activeDescendantControlRef.current ?? undefined,
                    }
                    abortController.current = focusZone(containerRef.current, vanillaSettings)
                    return () => {
                        abortController.current?.abort()
                    }
                } else {
                    abortController.current?.abort()
                }
            }
        },
        [disabled, ...dependencies],
    )
    return {containerRef, activeDescendantControlRef}
}