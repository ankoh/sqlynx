import { jest } from '@jest/globals';

import { GrpcServerStream, NativeAPIMock } from './native_api_mock.js';
import { PlatformType } from './platform_api.js';
import { GrpcChannelArgs } from './grpc_common.js';

import * as proto from "@ankoh/sqlynx-pb";
import { NativeHyperDatabaseClient } from './native_hyperdb_client.js';
import { NativeGrpcServerStreamBatchEvent } from './native_grpc_client.js';

describe('Native Hyper client', () => {
    let mock: NativeAPIMock | null;
    beforeEach(() => {
        mock = new NativeAPIMock(PlatformType.MACOS);
        jest.spyOn(global, 'fetch').mockImplementation((req) => mock!.process(req as Request));
    });
    afterEach(() => {
        (global.fetch as jest.Mock).mockRestore();
    });
    const testChannelArgs: GrpcChannelArgs = {
        endpoint: "http://localhost:8080"
    };

    // Test channel creation
    it("can create a channel", () => {
        const client = new NativeHyperDatabaseClient({
            proxyEndpoint: new URL("sqlynx-native://localhost")
        });
        expect(async () => await client.connect(testChannelArgs)).resolves;
    });
    // Make sure channel creation fails with wrong base url
    it("fails to create a channel with invalid base URL", () => {
        const client = new NativeHyperDatabaseClient({
            proxyEndpoint: new URL("not-sqlynx-native://localhost")
        });
        expect(async () => await client.connect(testChannelArgs)).rejects.toThrow();
    });

    // Test starting a server stream
    it("can start a streaming gRPC call", async () => {
        const client = new NativeHyperDatabaseClient({
            proxyEndpoint: new URL("sqlynx-native://localhost")
        });

        // Setup the channel
        const channel = await client.connect(testChannelArgs);
        expect(channel.grpcChannel.channelId).not.toBeNull();
        expect(channel.grpcChannel.channelId).not.toBeNaN();

        // Mock executeQuery call
        const executeQueryMock = jest.fn((_query: string) => new GrpcServerStream(200, "OK", {}, [
            {
                event: NativeGrpcServerStreamBatchEvent.FlushAfterClose,
                messages: [
                    new proto.salesforce_hyperdb_grpc_v1.pb.QueryResult()
                ],
            }
        ]));
        mock!.hyperService.executeQuery = (p) => executeQueryMock(p.query);

        // Start the server stream
        const params = new proto.salesforce_hyperdb_grpc_v1.pb.QueryParam({
            query: "select 1"
        });
        await channel.executeQuery(params);
        expect(executeQueryMock).toHaveBeenCalled();
        expect(executeQueryMock).toHaveBeenCalledWith("select 1");
    });

    // Test reading from a server stream
    it("can read form a gRPC output stream", async () => {
        const client = new NativeHyperDatabaseClient({
            proxyEndpoint: new URL("sqlynx-native://localhost")
        });

        // Setup the channel
        const channel = await client.connect(testChannelArgs);
        expect(channel.grpcChannel.channelId).not.toBeNull();
        expect(channel.grpcChannel.channelId).not.toBeNaN();

        // Build the first message that is returned to the client (in this test a header message)
        const headerMessage = new proto.salesforce_hyperdb_grpc_v1.pb.QueryResult({
            result: {
                case: "header",
                value: new proto.salesforce_hyperdb_grpc_v1.pb.QueryResultHeader({
                    header: {
                        case: "schema",
                        value: new proto.salesforce_hyperdb_grpc_v1.pb.QueryResultSchema({
                            column: []
                        })
                    }
                }),
            }
        });
        const bodyMessage = new proto.salesforce_hyperdb_grpc_v1.pb.QueryResult({
            result: {
                case: "arrowChunk",
                value: new proto.salesforce_hyperdb_grpc_v1.pb.QueryBinaryResultChunk({
                    data: new Uint8Array([0x01, 0x02, 0x03, 0x04]),
                }),
            }
        });

        // Mock executeQuery call
        const executeQueryMock = jest.fn((_query: string) => new GrpcServerStream(200, "OK", {}, [
            {
                event: NativeGrpcServerStreamBatchEvent.FlushAfterClose,
                messages: [headerMessage, bodyMessage],
            }
        ]));
        mock!.hyperService.executeQuery = (p) => executeQueryMock(p.query);

        // Start the server stream
        const params = new proto.salesforce_hyperdb_grpc_v1.pb.QueryParam({
            query: "select 1"
        });
        const stream = await channel.executeQuery(params);
        expect(executeQueryMock).toHaveBeenCalled();
        expect(executeQueryMock).toHaveBeenCalledWith("select 1");
        expect(stream.grpcStream.streamId).not.toBeNull();
        expect(stream.grpcStream.streamId).not.toBeNaN();

        // Read a message from the result stream
        const result = await stream.next();
        expect(result.done).not.toBeTruthy();
        const value = result.value;
        expect(value).not.toBeNull();
        expect(value).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0x04]));

        // The next read hits the end of the stream
        const next = await stream.next();
        expect(next.done).toBeTruthy();

    });
});