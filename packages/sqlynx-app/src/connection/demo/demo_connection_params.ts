import * as proto from '@ankoh/sqlynx-protobuf';

export function buildDemoConnectionParams(): proto.sqlynx_connection.pb.ConnectionParams {
    return new proto.sqlynx_connection.pb.ConnectionParams({
        connection: {
            case: "demo",
            value: new proto.sqlynx_connection.pb.DemoParams()
        }
    });
}
