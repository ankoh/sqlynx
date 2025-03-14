import * as proto from '@ankoh/sqlynx-protobuf';

export function buildServerlessConnectionParams(): proto.sqlynx_connection.pb.ConnectionParams {
    return new proto.sqlynx_connection.pb.ConnectionParams({
        connection: {
            case: "serverless",
            value: new proto.sqlynx_connection.pb.ServerlessParams()
        }
    });
}
