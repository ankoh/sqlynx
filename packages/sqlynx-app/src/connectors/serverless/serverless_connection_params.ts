import * as proto from '@ankoh/sqlynx-protobuf';

export function buildServerlessConnectorParams(): proto.sqlynx_workbook.pb.ConnectorParams {
    return new proto.sqlynx_workbook.pb.ConnectorParams({
        connector: {
            case: "serverless",
            value: new proto.sqlynx_workbook.pb.ServerlessParams()
        }
    });
}
