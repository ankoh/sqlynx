import * as React from 'react';

interface Props {
    className?: string;
}

export function BackgroundLayer(props: Props) {
    return (
        <svg className={props.className}>
            <pattern
                id="dots"
                x="0"
                y="0"
                width="16"
                height="16"
                patternUnits="userSpaceOnUse"
                patternTransform="translate(-0.5,-0.5)"
            >
                <circle cx="0.5" cy="0.5" r="0.5" fill="#aaa"></circle>
            </pattern>
            <rect x="0" y="0" width="100%" height="100%" fill="url(#dots)"></rect>
        </svg>
    );
}
