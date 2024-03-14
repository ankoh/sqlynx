import { jest } from '@jest/globals';

import { NativeAPIMock } from './native_api_mock.js';
import { PlatformType } from './platform_api.js';
import { NativeGrpcClient } from './native_grpc_client.js';

describe('Native gRPC client', () => {
    let mock: NativeAPIMock | null;
    beforeEach(() => {
        mock = new NativeAPIMock(PlatformType.MACOS);
        jest.spyOn(global, 'fetch').mockImplementation((req) => mock!.process(req as Request));
    });
    afterEach(() => {
        (global.fetch as jest.Mock).mockRestore();
    });

    it("can create a channel", () => {
        const client = new NativeGrpcClient({
            baseURL: new URL("sqlynx-native://[::1]")
        });
        expect(async () => await client.connectChannel()).resolves;
    });
    it("fails to create a channel with invalid base URL", () => {
        const client = new NativeGrpcClient({
            baseURL: new URL("not-sqlynx-native://[::1]")
        });
        expect(async () => await client.connectChannel()).rejects.toThrow();
    });
});
