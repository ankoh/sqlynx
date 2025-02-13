import * as proto from '@ankoh/sqlynx-protobuf';

export function buildDemoConnectorParams(): proto.sqlynx_workbook.pb.ConnectorParams {
    return new proto.sqlynx_workbook.pb.ConnectorParams({
        connector: {
            case: "demo",
            value: new proto.sqlynx_workbook.pb.DemoParams()
        }
    });
}
