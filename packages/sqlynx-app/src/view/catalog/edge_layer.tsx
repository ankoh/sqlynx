import * as React from 'react';

interface EdgeLayerProps {
    className?: string;
    width: number;
    height: number;
    padding: number;
    paths: React.ReactElement[];
}

export function EdgeLayer(props: EdgeLayerProps) {
    return (
        <div
            className={props.className}
            style={{
                padding: props.padding,
            }}
        >
            <svg
                viewBox={`0 0 ${props.width} ${props.height}`}
                width={props.width}
                height={props.height}
            >
                {props.paths}
            </svg>
        </div>
    );
}
