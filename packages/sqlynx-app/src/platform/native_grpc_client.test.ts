import { jest } from '@jest/globals';

import { GrpcServerStream, NativeAPIMock } from './native_api_mock.js';
import { PlatformType } from './platform_api.js';
import { NativeGrpcClient, NativeGrpcServerStreamBatchEvent } from './native_grpc_client.js';

import * as proto from "@ankoh/hyperdb-proto";

describe('Native gRPC client', () => {
    let mock: NativeAPIMock | null;
    beforeEach(() => {
        mock = new NativeAPIMock(PlatformType.MACOS);
        jest.spyOn(global, 'fetch').mockImplementation((req) => mock!.process(req as Request));
    });
    afterEach(() => {
        (global.fetch as jest.Mock).mockRestore();
    });

    // Test channel creation
    it("can create a channel", () => {
        const client = new NativeGrpcClient({
            baseURL: new URL("sqlynx-native://[::1]")
        });
        expect(async () => await client.connectChannel()).resolves;
    });
    // Make sure channel creation fails with wrong base url
    it("fails to create a channel with invalid base URL", () => {
        const client = new NativeGrpcClient({
            baseURL: new URL("not-sqlynx-native://[::1]")
        });
        expect(async () => await client.connectChannel()).rejects.toThrow();
    });

    describe('channels', () => {
        // Test starting a server stream
        it("can start a streaming gRPC call", async () => {
            const client = new NativeGrpcClient({
                baseURL: new URL("sqlynx-native://[::1]")
            });

            // Setup the channel
            const channel = await client.connectChannel();
            expect(channel.channelId).not.toBeNull();
            expect(channel.channelId).not.toBeNaN();

            // Mock executeQuery call
            const executeQueryMock = jest.fn((_query: string) => new GrpcServerStream(200, "OK", {}, [
                {
                    event: NativeGrpcServerStreamBatchEvent.FlushAfterClose,
                    messages: [
                        new proto.pb.QueryResult()
                    ],
                }
            ]));
            mock!.hyperService.executeQuery = (p) => executeQueryMock(p.query);

            // Start the server stream
            const params = new proto.pb.QueryParam({
                query: "select 1"
            });
            await channel.startServerStream({
                path: "/salesforce.hyperdb.grpc.v1.HyperService/ExecuteQuery",
                body: params.toBinary(),
                tlsClientKeyPath: null,
                tlsClientCertPath: null,
                tlsCacertsPath: null,
            });
            expect(executeQueryMock).toHaveBeenCalled();
            expect(executeQueryMock).toHaveBeenCalledWith("select 1");
        });

        // Test reading from a server stream
        it("can read form a gRPC output stream", async () => {
            const client = new NativeGrpcClient({
                baseURL: new URL("sqlynx-native://[::1]")
            });

            // Setup the channel
            const channel = await client.connectChannel();
            expect(channel.channelId).not.toBeNull();
            expect(channel.channelId).not.toBeNaN();

            // Build the first message that is returned to the client (in this test a header message)
            const headerMessage = new proto.pb.QueryResult({
                result: {
                    case: "header",
                    value: new proto.pb.QueryResultHeader({
                        header: {
                            case: "schema",
                            value: new proto.pb.QueryResultSchema({
                                column: []
                            })
                        }
                    }),
                }
            });

            // Mock executeQuery call
            const executeQueryMock = jest.fn((_query: string) => new GrpcServerStream(200, "OK", {}, [
                {
                    event: NativeGrpcServerStreamBatchEvent.FlushAfterClose,
                    messages: [headerMessage],
                }
            ]));
            mock!.hyperService.executeQuery = (p) => executeQueryMock(p.query);

            // Start the server stream
            const params = new proto.pb.QueryParam({
                query: "select 1"
            });
            const stream = await channel.startServerStream({
                path: "/salesforce.hyperdb.grpc.v1.HyperService/ExecuteQuery",
                body: params.toBinary(),
                tlsClientKeyPath: null,
                tlsClientCertPath: null,
                tlsCacertsPath: null,
            });
            expect(executeQueryMock).toHaveBeenCalled();
            expect(executeQueryMock).toHaveBeenCalledWith("select 1");
            expect(stream.streamId).not.toBeNull();
            expect(stream.streamId).not.toBeNaN();

            // Read a message from the result stream
            const result = await stream.read();
            expect(result).not.toBeNull();
            expect(result.event).toEqual(NativeGrpcServerStreamBatchEvent.FlushAfterClose);
            expect(result.messages.length).toEqual(1);

            // The stream should get cleaned up after the last read.
            // The client is expected to understand that "FlushAfterClose" hints at the stream being closed now.
            // Subsequent reads will fail.
            expect(stream.read()).rejects.toThrow(new Error("stream not found"));

        });
    });
});
