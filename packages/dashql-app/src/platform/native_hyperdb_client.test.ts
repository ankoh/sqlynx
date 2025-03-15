import { jest } from '@jest/globals';

import * as proto from "@ankoh/dashql-protobuf";

import { GrpcServerStream, NativeAPIMock } from './native_api_mock.js';
import { ChannelArgs } from './channel_common.js';
import { NativeHyperDatabaseClient, NativeHyperQueryResultStream } from './native_hyperdb_client.js';
import { NativeGrpcServerStreamBatchEvent } from './native_grpc_client.js';
import { PlatformType } from './platform_type.js';
import { TestLogger } from './test_logger.js';
import { AttachedDatabase, HyperDatabaseConnectionContext } from '../connection/hyper/hyperdb_client.js';

describe('Native Hyper client', () => {
    let mock: NativeAPIMock | null;
    beforeEach(() => {
        mock = new NativeAPIMock(PlatformType.MACOS);
        jest.spyOn(global, 'fetch').mockImplementation((req) => mock!.process(req as Request));
    });
    afterEach(() => {
        (global.fetch as jest.Mock).mockRestore();
    });
    const testChannelArgs: ChannelArgs = {
        endpoint: "http://localhost:8080"
    };
    const fakeConnection: HyperDatabaseConnectionContext = {
        getAttachedDatabases(): AttachedDatabase[] {
            return []
        },
        getRequestMetadata(): Promise<Record<string, string>> {
            return Promise.resolve({});
        }
    };

    // Test channel creation
    it("can create a channel", () => {
        const logger = new TestLogger();
        const client = new NativeHyperDatabaseClient({
            proxyEndpoint: new URL("dashql-native://localhost")
        }, logger);
        expect(async () => await client.connect(testChannelArgs, fakeConnection)).resolves;
    });
    // Make sure channel creation fails with wrong foundations url
    it("fails to create a channel with invalid foundations URL", () => {
        const logger = new TestLogger();
        const client = new NativeHyperDatabaseClient({
            proxyEndpoint: new URL("not-dashql-native://localhost")
        }, logger);
        expect(async () => await client.connect(testChannelArgs, fakeConnection)).rejects.toThrow();
    });

    // Test starting a server stream
    it("can start a streaming gRPC call", async () => {
        const logger = new TestLogger();
        const client = new NativeHyperDatabaseClient({
            proxyEndpoint: new URL("dashql-native://localhost")
        }, logger);

        // Setup the channel
        const channel = await client.connect(testChannelArgs, fakeConnection);
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
        const logger = new TestLogger();
        const client = new NativeHyperDatabaseClient({
            proxyEndpoint: new URL("dashql-native://localhost")
        }, logger);

        // Setup the channel
        const channel = await client.connect(testChannelArgs, fakeConnection);
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
        const stream = await channel.executeQuery(params) as NativeHyperQueryResultStream;
        expect(executeQueryMock).toHaveBeenCalled();
        expect(executeQueryMock).toHaveBeenCalledWith("select 1");
        expect(stream.resultReader.grpcStream.streamId).not.toBeNull();
        expect(stream.resultReader.grpcStream.streamId).not.toBeNaN();

        // Read a message from the result stream directly
        const result = await stream.resultReader.grpcStream.next();
        expect(result.done).not.toBeTruthy();
        const value = result.value;
        expect(value).not.toBeNull();
        //      XXX Check body when we write proper arrow in this test
        //        expect(value).toEqual(new Uint8Array([
        //            0x01, 0x02, 0x03, 0x04
        //        ]));

        // The next read hits the end of the stream
        const next = await stream.resultReader.grpcStream.next();
        expect(next.done).toBeTruthy();

    });
});
