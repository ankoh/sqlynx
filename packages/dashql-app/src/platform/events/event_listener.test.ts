import { describe, expect, it, vi } from 'vitest';

import { SETUP_SESSION_URL, type SetupEventVariant } from './event.js';
import { parseClipboardSetup, PlatformEventListener } from './event_listener.js';
import { TestLogger } from '../logger/test_logger.js';

class TestPlatformEventListener extends PlatformEventListener {
    public starts = 0;
    public stops = 0;

    protected async listenForAppEvents(): Promise<void> { this.starts += 1; }
    protected stopListeningForAppEvents(): void { this.stops += 1; }
}

describe('PlatformEventListener clipboard events', () => {
    function paste(text: string) {
        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();
        const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
        Object.defineProperties(event, {
            clipboardData: { value: { getData: () => text } },
            preventDefault: { value: preventDefault },
            stopPropagation: { value: stopPropagation },
        });
        document.dispatchEvent(event);
        return { preventDefault, stopPropagation };
    }

    it.each([
        'dashql://localhost?session=https%3A%2F%2Fexample.com%2Fdashql-session.json',
        'https://dashql.app/?session=https%3A%2F%2Fexample.com%2Fdashql-session.json',
        'http://localhost:9002/?session=https%3A%2F%2Fexample.com%2Fdashql-session.json',
    ])('accepts a session link from %s', link => {
        expect(parseClipboardSetup(link)).toEqual({
            type: 'session',
            value: 'https://example.com/dashql-session.json',
        });
    });

    it.each([
        'https://example.com/?session=https%3A%2F%2Fexample.com%2Fdashql-session.json',
        'http://dashql.app/?session=https%3A%2F%2Fexample.com%2Fdashql-session.json',
        'http://localhost:9003/?session=https%3A%2F%2Fexample.com%2Fdashql-session.json',
    ])('rejects an app link from an untrusted origin: %s', link => {
        expect(parseClipboardSetup(link)).toBeNull();
    });

    it('dispatches a session setup event from a pasted app URL', async () => {
        const listener = new TestPlatformEventListener(new TestLogger());
        const setupEvents: SetupEventVariant[] = [];
        listener.subscribeSetupEvents(event => setupEvents.push(event));
        await listener.setup();

        const { preventDefault, stopPropagation } = paste(
            'http://localhost:9002/?session=http://localhost:9002/static/examples/sessions/explain/dashql-session.json',
        );

        expect(setupEvents).toEqual([{
            type: SETUP_SESSION_URL,
            value: 'http://localhost:9002/static/examples/sessions/explain/dashql-session.json',
        }]);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(stopPropagation).toHaveBeenCalledOnce();
        listener.dispose();
    });

    it('dispatches unhandled pasted text to fallback subscribers without trimming it', async () => {
        const listener = new TestPlatformEventListener(new TestLogger());
        const fallbackPastes: string[] = [];
        const handler = (text: string) => fallbackPastes.push(text);
        listener.subscribeFallbackPasteEvents(handler);
        await listener.setup();

        const { preventDefault, stopPropagation } = paste('  query plan\n');

        expect(fallbackPastes).toEqual(['  query plan\n']);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(stopPropagation).toHaveBeenCalledOnce();

        listener.unsubscribeFallbackPasteEvents(handler);
        paste('ignored');
        expect(fallbackPastes).toHaveLength(1);
        listener.dispose();
    });

    it('sets up global listeners once and removes them on dispose', async () => {
        const listener = new TestPlatformEventListener(new TestLogger());
        await listener.setup();
        await listener.setup();
        expect(listener.starts).toBe(1);

        listener.dispose();
        listener.dispose();
        expect(listener.stops).toBe(1);
    });
});
