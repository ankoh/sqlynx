import { jest } from '@jest/globals';

import { NativeAPIMock } from './native_api_mock.js';
import { PlatformType } from './platform_api.js';

describe('Native API mock', () => {
    beforeEach(() => {
        const mock = new NativeAPIMock(PlatformType.MACOS);
        jest.spyOn(global, 'fetch').mockImplementation((req) => mock.process(req as Request));
    });
    afterEach(() => {
        (global.fetch as jest.Mock).mockRestore();
    })

    it("rejects requests that are not targeting sqlynx-native://", async () => {
        const request = new Request(new URL("not-sqlynx-native://[::1]/foo"), {
            method: 'POST',
            headers: {}
        });
        const response = await fetch(request);
        expect(response.status).toEqual(400);
    });
    it("rejects requests with an invalid request path", async () => {
        const request = new Request(new URL("sqlynx-native://[::1]/invalid-path"), {
            method: 'POST',
            headers: {}
        });
        const response = await fetch(request);
        expect(response.statusText).toEqual("unknown request path");
        expect(response.status).toEqual(400);
    });
    it("accepts requests that are targeting the root path /", async () => {
        const request = new Request(new URL("sqlynx-native://[::1]/"), {
            method: 'POST',
            headers: {}
        });
        const response = await fetch(request);
        expect(response.statusText).toEqual("OK");
        expect(response.status).toEqual(200);
    })
    it("create channels when POSTing to /grpc/channels", async () => {
        const request = new Request(new URL("sqlynx-native://[::1]/grpc/channels"), {
            method: 'POST',
            headers: {}
        });
        const response = await fetch(request);
        expect(response.statusText).toEqual("OK");
        expect(response.status).toEqual(200);
        expect(response.headers.has("sqlynx-channel-id")).toBeTruthy();
        expect(() => {
            Number.parseInt(response.headers.get("sqlynx-channel-id")!)
        }).not.toThrow();
    });
});
