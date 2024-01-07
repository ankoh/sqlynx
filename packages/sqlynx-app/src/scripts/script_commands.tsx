import React from 'react';
import { KeyEventHandler, KeyEventHandlerType as KeyEventHandlerVariant, useKeyEvents } from '../utils/key_events';

interface Props {
    children?: React.ReactElement;
}

export const ScriptCommands: React.FC<Props> = (props: Props) => {
    const subscribers = React.useMemo<KeyEventHandler[]>(() => {
        return [
            {
                variant: KeyEventHandlerVariant.ACTION,
                key: 'E',
                callback: () => {},
            },
            {
                variant: KeyEventHandlerVariant.ACTION,
                key: 'R',
                callback: () => {},
            },
            {
                variant: KeyEventHandlerVariant.ACTION,
                key: 'L',
                callback: () => {},
            },
            {
                variant: KeyEventHandlerVariant.ACTION,
                key: 'S',
                callback: () => {},
            },
            {
                variant: KeyEventHandlerVariant.ACTION,
                key: 'A',
                callback: () => {},
            },
        ];
    }, []);
    useKeyEvents(subscribers);

    return props.children;
};
