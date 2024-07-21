import * as React from 'react';

interface HighlightingProps {
    className?: string;
    width: number;
    height: number;
    paths: string[];
}

export function EdgeLayer(props: HighlightingProps) {
    const paths = [];
    for (let i = 0; i < props.paths.length; ++i) {
        paths.push(
            <path
                key={i.toString()}
                d={props.paths[i]}
                strokeWidth="2px"
                stroke="black"
                fill="transparent"
            />,
        );
    }
    return (
        <svg
            className={props.className}
            viewBox={`0 0 ${props.width} ${props.height}`}
            width={props.width}
            height={props.height}
        >
            {paths}
        </svg>
    );
}
