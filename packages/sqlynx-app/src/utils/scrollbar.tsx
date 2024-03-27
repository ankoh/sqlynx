import * as React from 'react';

let SCROLLBAR_WIDTH: number | null = null;

// Kudos to: https://www.robinwieruch.de/react-hook-scrollbar-width/

export const useScrollbarWidth = () => {
    if (SCROLLBAR_WIDTH !== null) {
        return SCROLLBAR_WIDTH;
    }

    // Creating invisible container
    const outer = document.createElement('div');
    outer.style.visibility = 'hidden';
    outer.style.overflow = 'scroll';
    (outer.style as any).msOverflowStyle = 'scrollbar';
    document.body.appendChild(outer);

    // Creating inner element and placing it in the container
    const inner = document.createElement('div');
    outer.appendChild(inner);

    // Calculating difference between container's full width and the child width
    SCROLLBAR_WIDTH = outer.offsetWidth - inner.offsetWidth;

    // Removing temporary elements from the DOM
    outer.parentNode?.removeChild(outer);
    return SCROLLBAR_WIDTH;
};
