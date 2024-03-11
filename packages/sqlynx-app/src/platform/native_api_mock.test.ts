import * as proto from "@ankoh/hyperdb-proto";

import { jest } from '@jest/globals';

import { GrpcServerStream, GrpcServerStreamBatch, GrpcServerStreamBatchEvent, NativeAPIMock } from './native_api_mock.js';
import { PlatformType } from './platform_api.js';

describe('Native API mock', () => {
    let mock: NativeAPIMock | null;
    beforeEach(() => {
        mock = new NativeAPIMock(PlatformType.MACOS);
        jest.spyOn(global, 'fetch').mockImplementation((req) => mock!.process(req as Request));
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
    });

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
    });

    it("returns a server stream id for streaming gRPC calls", async () => {
        const channelRequest = new Request(new URL("sqlynx-native://[::1]/grpc/channels"), {
            method: 'POST',
            headers: {}
        });
        const channelResponse = await fetch(channelRequest);
        expect(channelResponse.statusText).toEqual("OK");
        expect(channelResponse.status).toEqual(200);
        expect(channelResponse.headers.has("sqlynx-channel-id")).toBeTruthy();
        const channelId = Number.parseInt(channelResponse.headers.get("sqlynx-channel-id")!);

        // Mock the next ExecuteQuery call
        const messageToRespond = new proto.pb.QueryResult({
            result: {
                case: "header",
                value: new proto.pb.QueryResultHeader(),
            }
        });
        const respondSingleMessage = (_req: proto.pb.QueryParam) => {
            const initialStatus = 200;
            const initialStatusMessage = "OK";
            const initialMetadata: Record<string, string> = {
                "some-server-metadata": "some-value",
            };
            const batches: GrpcServerStreamBatch[] = [
                {
                    event: GrpcServerStreamBatchEvent.FlushAfterClose,
                    messages: [messageToRespond],
                }
            ];
            const result = new GrpcServerStream(initialStatus, initialStatusMessage, initialMetadata, batches);
            return result;
        };
        const executeQueryMock = jest.fn(respondSingleMessage);
        mock!.hyperService.executeQuery = (req: proto.pb.QueryParam) => executeQueryMock.call(req);

        // Send the ExecuteQuery request
        const params = new proto.pb.QueryParam();
        params.query = "select 1";
        const paramsBuffer = params.toBinary();
        const streamRequest = new Request(new URL(`sqlynx-native://[::1]/grpc/channel/${channelId}/streams`), {
            method: 'POST',
            headers: {
                "sqlynx-path": "/salesforce.hyperdb.grpc.v1.HyperService/ExecuteQuery"
            },
            body: paramsBuffer,
        });
        const streamResponse = await fetch(streamRequest);

        // Retrieve and check the initial metadata
        expect(streamResponse.status).toEqual(200);
        expect(streamResponse.headers.get("sqlynx-channel-id")).toEqual(channelId.toString());
        expect(streamResponse.headers.has("sqlynx-stream-id")).toBeTruthy();
        expect(streamResponse.headers.get("some-server-metadata")).toEqual("some-value");
        expect(executeQueryMock).toHaveBeenCalled();
        const streamId = Number.parseInt(streamResponse.headers.get("sqlynx-stream-id")!);

        // Now read from the stream
        const readRequest = new Request(new URL(`sqlynx-native://[::1]/grpc/channel/${channelId}/stream/${streamId}`), {
            method: 'GET',
            headers: {
                "sqlynx-path": "/salesforce.hyperdb.grpc.v1.HyperService/ExecuteQuery"
            },
        });

        const expectedMessage = messageToRespond.toBinary();
        const expectedBuffer = new ArrayBuffer(expectedMessage.length + 4);
        (new DataView(expectedBuffer)).setUint32(expectedMessage.length, 0, true);
        (new Uint8Array(expectedBuffer, 4)).set(expectedMessage);

        const readResponse = await fetch(readRequest);
        expect(readResponse.statusText).toEqual("OK");
        expect(readResponse.status).toEqual(200);
        expect(readResponse.headers.has("sqlynx-channel-id")).toBeTruthy();
        expect(readResponse.headers.has("sqlynx-stream-id")).toBeTruthy();
        expect(readResponse.headers.get("sqlynx-batch-event")).toEqual("FlushAfterClose");
        expect(readResponse.headers.get("sqlynx-batch-messages")).toEqual("1");
        expect(readResponse.headers.get("sqlynx-batch-bytes")).toEqual(expectedMessage.length.toString());
        expect(await readResponse.arrayBuffer()).toEqual(expectedBuffer);
    });
});
