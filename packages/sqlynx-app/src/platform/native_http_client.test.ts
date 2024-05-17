import { jest } from '@jest/globals';

import { NativeAPIMock } from './native_api_mock.js';
import { PlatformType } from './platform_type.js';
import { TestLogger } from './test_logger.js';
import { NativeHttpClient } from './native_http_client.js';

describe('Native HTTP client', () => {
    let mock: NativeAPIMock | null;
    beforeEach(() => {
        mock = new NativeAPIMock(PlatformType.MACOS);
        jest.spyOn(global, 'fetch').mockImplementation((req) => mock!.process(req as Request));
    });
    afterEach(() => {
        (global.fetch as jest.Mock).mockRestore();
    });
    const endpoint = "http://localhost:8080"

    // Test starting a server stream without registered mock
    it("fails when no mock is registered", async () => {
        const logger = new TestLogger();
        const client = new NativeHttpClient({
            proxyEndpoint: new URL("sqlynx-native://localhost")
        }, logger);
        const url = new URL(`${endpoint}/foo/bar`);
        const response = await client.fetch(url, {
            method: "POST",
        });
        expect(response.status).toEqual(400);
        expect(response.statusText).toEqual("unexpected http call");
    });
});

