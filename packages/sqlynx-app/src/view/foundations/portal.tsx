/// This file is copied almost as-is from the Portal of @primer/react

import * as React from 'react'
import { createPortal } from 'react-dom'

const SQLYNX_PORTAL_ROOT_ID = '__sqlynxPortalRoot__'
const DEFAULT_PORTAL_CONTAINER_NAME = '__default__'

const portalRootRegistry: Partial<Record<string, Element>> = {}

/// Register a container to serve as a portal root.
/// If name is not specified, registers the default portal root.
export function registerPortalRoot(root: Element, name = DEFAULT_PORTAL_CONTAINER_NAME): void {
    portalRootRegistry[name] = root
}

/// Ensures that a default portal root exists and is registered. If a DOM element exists
/// with id __sqlynxPortalRoot__, allow that element to serve as the default portal root.
/// Otherwise, create that element and attach it to the end of document.body.
function ensureDefaultPortal() {
    const existingDefaultContainer = portalRootRegistry[DEFAULT_PORTAL_CONTAINER_NAME]
    if (!existingDefaultContainer || !document.body.contains(existingDefaultContainer)) {
        let defaultContainer = document.getElementById(SQLYNX_PORTAL_ROOT_ID)
        if (!(defaultContainer instanceof Element)) {
            defaultContainer = document.createElement('div')
            defaultContainer.setAttribute('id', SQLYNX_PORTAL_ROOT_ID)
            defaultContainer.style.position = 'absolute'
            defaultContainer.style.top = '0'
            defaultContainer.style.left = '0'
            const suitablePortalRoot = document.querySelector('[data-portal-root]')
            if (suitablePortalRoot) {
                suitablePortalRoot.appendChild(defaultContainer)
            } else {
                document.body.appendChild(defaultContainer)
            }
        }
        registerPortalRoot(defaultContainer)
    }
}

export interface PortalProps {
    /// Called when this portal is added to the DOM
    onMount?: () => void
    /// Optional. Mount this portal at the container specified
    /// by this name. The container must be previously registered
    /// with `registerPortal`.
    containerName?: string
    /// The children elements
    children?: React.ReactElement;
}

/// Creates a React Portal, placing all children in a separate physical DOM root node.
export function Portal(props: PortalProps) {
    const elementRef = React.useRef<HTMLDivElement | null>(null)
    if (!elementRef.current) {
        const div = document.createElement('div')
        // Portaled content should get their own stacking context so they don't interfere
        // with each other in unexpected ways. One should never find themselves tempted
        // to change the zIndex to a value other than "1".
        div.style.position = 'relative'
        div.style.zIndex = '1'
        elementRef.current = div
    }
    const element = elementRef.current;

    React.useLayoutEffect(() => {
        let containerName = props.containerName
        if (containerName === undefined) {
            containerName = DEFAULT_PORTAL_CONTAINER_NAME
            ensureDefaultPortal();
        }
        const parentElement = portalRootRegistry[containerName];
        if (!parentElement) {
            throw new Error(
                `Portal container '${props.containerName}' is not yet registered. Container must be registered with registerPortal before use.`,
            )
        }
        parentElement.appendChild(element);
        props.onMount?.();

        return () => {
            parentElement.removeChild(element)
        }
    }, [element]);

    return createPortal(props.children, element);
}
