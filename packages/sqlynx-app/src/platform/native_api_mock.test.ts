import { jest } from '@jest/globals';

import { NativeAPIMock } from './native_api_mock.js';
import { PlatformType } from './platform_api.js';

describe('Native API mock', () => {
    it("rejects requests that are not targeting sqlynx-native://", async () => {
        const mock = new NativeAPIMock(PlatformType.MACOS);
        jest.spyOn(global, 'fetch').mockImplementation((req) => mock.process(req as Request));
        const request = new Request(new URL("not-sqlynx-native://foo"), {
            method: 'POST',
            headers: {}
        });
        const response = await fetch(request);
        expect(response.status).toEqual(400);
        (global.fetch as jest.Mock).mockRestore();
    });
    it("rejects requests with an invalid request path", async () => {
        const mock = new NativeAPIMock(PlatformType.MACOS);
        jest.spyOn(global, 'fetch').mockImplementation((req) => mock.process(req as Request));
        const request = new Request(new URL("sqlynx-native://local/invalid-path"), {
            method: 'POST',
            headers: {}
        });
        const response = await fetch(request);
        expect(response.status).toEqual(400);
        expect(response.statusText).toEqual("unknown request path");
        (global.fetch as jest.Mock).mockRestore();
    });
    it("accepts requests that are targeting the root path /", async () => {
        const mock = new NativeAPIMock(PlatformType.MACOS);
        jest.spyOn(global, 'fetch').mockImplementation((req) => mock.process(req as Request));
        const request = new Request(new URL("sqlynx-native://local/"), {
            method: 'POST',
            headers: {}
        });
        const response = await fetch(request);
        expect(response.status).toEqual(200);
        (global.fetch as jest.Mock).mockRestore();
    })
});
