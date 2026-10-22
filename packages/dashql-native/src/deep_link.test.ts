import {describe, expect, it, vi} from "vitest";

import {
    DeepLinkQueue,
    MAX_DEEP_LINK_DATA_LENGTH,
    parseDeepLink,
    parseDeepLinksFromCommandLine,
} from "./deep_link.js";

describe("parseDeepLink", () => {
    it("extracts the single event payload", () => {
        expect(parseDeepLink("dashql://localhost?data=eyJub3RlYm9vayI6ImFiYyJ9")).toEqual({
            type: "event",
            value: "eyJub3RlYm9vayI6ImFiYyJ9",
        });
    });

    it.each([
        "dashql://localhost?session=https%3A%2F%2Fexample.com%2Fdashql-session.json",
        "https://dashql.app/?session=https%3A%2F%2Fexample.com%2Fdashql-session.json",
        "http://localhost:9002/?session=https%3A%2F%2Fexample.com%2Fdashql-session.json",
        "dashql://localhost?notebook=https%3A%2F%2Fexample.com%2Fdashql-session.json",
        "https://dashql.app/?notebook=https%3A%2F%2Fexample.com%2Fdashql-session.json",
    ])("extracts session payloads from supported links: %s", (link) => {
        expect(parseDeepLink(link)).toEqual({
            type: "session",
            value: "https://example.com/dashql-session.json",
        });
    });

    it.each([
        "not a URL",
        "https://localhost?data=abc",
        "https://example.com?data=abc",
        "http://dashql.app?data=abc",
        "http://localhost:9003?data=abc",
        "dashql://remote?data=abc",
        "dashql://user@localhost?data=abc",
        "dashql://localhost:443?data=abc",
        "dashql://localhost/path?data=abc",
        "dashql://localhost?other=abc",
        "dashql://localhost?data=abc&data=def",
        "dashql://localhost?data=abc&other=def",
        "dashql://localhost?data=abc#fragment",
        "dashql://localhost?data=",
        `dashql://localhost?data=${"a".repeat(MAX_DEEP_LINK_DATA_LENGTH + 1)}`,
    ])("rejects an invalid or out-of-scope URL: %s", (link) => {
        expect(parseDeepLink(link)).toBeNull();
    });

    it("finds valid deep links among application arguments", () => {
        expect(parseDeepLinksFromCommandLine([
            "/Applications/DashQL.app/Contents/MacOS/DashQL",
            "--flag",
            "dashql://localhost?data=first",
            "dashql://remote?data=ignored",
            "dashql://localhost?data=second",
        ])).toEqual([
            {type: "event", value: "first"},
            {type: "event", value: "second"},
        ]);
    });
});

describe("DeepLinkQueue", () => {
    it("buffers cold-start links and delivers later links immediately", () => {
        const queue = new DeepLinkQueue();
        const initial = {type: "event", value: "initial"} as const;
        const running = {type: "session", value: "https://example.com/dashql-session.json"} as const;
        queue.push(initial);
        const receiver = vi.fn();

        expect(queue.attach(receiver)).toEqual([initial]);
        queue.push(running);
        expect(receiver).toHaveBeenCalledWith(running);
    });

    it("resumes buffering while the renderer is unavailable", () => {
        const queue = new DeepLinkQueue();
        queue.attach(vi.fn());
        queue.detach();
        const link = {type: "event", value: "after-reload"} as const;
        queue.push(link);
        expect(queue.attach(vi.fn())).toEqual([link]);
    });
});
