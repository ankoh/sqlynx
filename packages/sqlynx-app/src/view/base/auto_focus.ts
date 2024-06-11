import type React from 'react'
import {useEffect} from 'react'
import {iterateFocusableElements} from '@primer/behaviors/utils'

export type UseOpenAndCloseFocusArgs = {
    initialFocusRef?: React.RefObject<HTMLElement>
    containerRef: React.RefObject<HTMLElement>
    returnFocusRef: React.RefObject<HTMLElement>
    preventFocusOnOpen?: boolean
}

export function useOpenAndCloseFocus(args: UseOpenAndCloseFocusArgs): void {
    useEffect(() => {
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