import * as proto from '@ankoh/sqlynx-protobuf';

export function buildDemoConnectorParams(): proto.sqlynx_session.pb.ConnectorParams {
    return new proto.sqlynx_session.pb.ConnectorParams({
        connector: {
            case: "demo",
            value: new proto.sqlynx_session.pb.DemoParams()
        }
    });
}
