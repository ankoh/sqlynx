import { jest } from '@jest/globals';

import { HttpServerStream, HttpServerStreamBatch, NativeAPIMock } from './native_api_mock.js';
import { PlatformType } from './platform_type.js';
import { TestLogger } from './test_logger.js';
import { NativeHttpClient, NativeHttpServerStreamBatchEvent } from './native_http_client.js';

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
        const responseJson = await response.json();
        expect(responseJson.message).toEqual("unexpected http call");
    });

    // Tests reading from an HTTP output stream
    it("reads from an HTTP output stream", async () => {
        // Prepare a mocked result stream
        let resultStream: HttpServerStream | null = null;
        const startStream = (_req: Request) => {
            const initialStatus = 200;
            const initialStatusMessage = "OK";
            const initialMetadata: Record<string, string> = {
                "some-server-metadata": "some-value",
            };
            const batches: HttpServerStreamBatch[] = [
                {
                    event: NativeHttpServerStreamBatchEvent.FlushAfterTimeout,
                    chunks: [
                        new Uint8Array([1, 2, 3, 4]),
                        new Uint8Array([5, 6, 7, 8])
                    ],
                },
                {
                    event: NativeHttpServerStreamBatchEvent.FlushAfterClose,
                    chunks: [
                        new Uint8Array([9, 10, 11, 12])
                    ],
                }
            ];
            resultStream = new HttpServerStream(initialStatus, initialStatusMessage, initialMetadata, batches);
            return resultStream;
        };
        const startStreamMock = jest.fn(startStream);
        mock!.httpServer.processRequest = (req: Request) => startStreamMock.call(req);

        // Create HTTP client
        const logger = new TestLogger();
        const client = new NativeHttpClient({
            proxyEndpoint: new URL("sqlynx-native://localhost")
        }, logger);
        const url = new URL(`${endpoint}/foo/bar`);

        // Fetch from the remote
        const response = await client.fetch(url, {
            method: "POST",
        });
        expect(response.status).toEqual(200);

        // Compare the buffers
        const buffer = await response.arrayBuffer();
        expect(new Uint8Array(buffer)).toEqual(new Uint8Array([
            1, 2, 3, 4,
            5, 6, 7, 8,
            9, 10, 11, 12,
        ]));
    });
});

