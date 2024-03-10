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
        expect(response.statusText).toEqual("invalid request: path=/invalid-path method=POST");
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
    it("create channels on POST to /grpc/channels", async () => {
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
    it("deletes created channel on DELETE to /grpc/channel/<channel-id>", async () => {
        const createRequest = new Request(new URL("sqlynx-native://[::1]/grpc/channels"), {
            method: 'POST',
            headers: {}
        });
        const createResponse = await fetch(createRequest);
        expect(createResponse.statusText).toEqual("OK");
        expect(createResponse.status).toEqual(200);
        expect(createResponse.headers.has("sqlynx-channel-id")).toBeTruthy();
        const channelId = Number.parseInt(createResponse.headers.get("sqlynx-channel-id")!);
        const deleteRequest = new Request(new URL(`sqlynx-native://[::1]/grpc/channel/${channelId}`), {
            method: 'DELETE',
            headers: {}
        });
        const deleteResponse = await fetch(deleteRequest);
        expect(deleteResponse.statusText).toEqual("OK");
        expect(deleteResponse.status).toEqual(200);
    });
    it("reports an error if the path for a streaming gRPC call is unknown", async () => {
        const createRequest = new Request(new URL("sqlynx-native://[::1]/grpc/channels"), {
            method: 'POST',
            headers: {}
        });
        const createResponse = await fetch(createRequest);
        expect(createResponse.statusText).toEqual("OK");
        expect(createResponse.status).toEqual(200);
        expect(createResponse.headers.has("sqlynx-channel-id")).toBeTruthy();
        const channelId = Number.parseInt(createResponse.headers.get("sqlynx-channel-id")!);

        const streamRequest = new Request(new URL(`sqlynx-native://[::1]/grpc/channel/${channelId}/streams`), {
            method: 'POST',
            headers: {
                "sqlynx-path": "/salesforce.hyperdb.grpc.v1.HyperService/ExecuteQuery"
            }
        });
        const streamResponse = await fetch(streamRequest);
        expect(streamResponse.statusText).toEqual(`unexpected gRPC call of: /salesforce.hyperdb.grpc.v1.HyperService/ExecuteQuery`);
        expect(streamResponse.status).toEqual(400);
    })
});
