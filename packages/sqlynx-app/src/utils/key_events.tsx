import React from 'react';

type KeyEventCallback = (event: KeyboardEvent) => void;

export interface KeyEventHandler {
    key: string;
    ctrlKey: boolean;
    callback: KeyEventCallback;
}

export function useKeyEvents(subscribers: KeyEventHandler[]) {
    const subscribersRef = React.useRef<KeyEventHandler[]>([]);
    React.useEffect(() => {
        subscribersRef.current = subscribers;
    }, [subscribers]);
    const handleKeyPress = React.useCallback<(event: KeyboardEvent) => void>((event: KeyboardEvent) => {
        for (const subscriber of subscribersRef.current) {
            if (subscriber.ctrlKey && event.ctrlKey && subscriber.key == event.key) {
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
