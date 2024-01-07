import React from 'react';

export enum KeyEventHandlerType {
    ACTION = 1,
}

type KeyEventCallback = (event: KeyboardEvent) => void;

export interface KeyEventHandler {
    variant: KeyEventHandlerType;
    key: string;
    callback: KeyEventCallback;
}

function matchesKeyPress(subscriber: KeyEventHandler, event: KeyboardEvent) {
    switch (subscriber.variant) {
        case KeyEventHandlerType.ACTION:
            return event.ctrlKey && event.key == subscriber.key;
    }
}

export function useKeyEvents(subscribers: KeyEventHandler[]) {
    const subscribersRef = React.useRef<KeyEventHandler[]>([]);
    React.useEffect(() => {
        subscribersRef.current = subscribers;
    }, [subscribers]);
    const handleKeyPress = React.useCallback<(event: KeyboardEvent) => void>((event: KeyboardEvent) => {
        for (const subscriber of subscribersRef.current) {
            if (matchesKeyPress(subscriber, event)) {
                subscriber.callback(event);
            }
        }
    }, []);
    React.useEffect(() => {
        const target = document;
        if (target) {
            target.addEventListener('keydown', handleKeyPress);
            return () => target.removeEventListener('keydown', handleKeyPress);
        } else {
            return () => {};
        }
    }, [handleKeyPress, document]);
}
