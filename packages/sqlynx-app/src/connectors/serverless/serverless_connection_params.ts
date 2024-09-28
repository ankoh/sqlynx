import * as proto from '@ankoh/sqlynx-pb';

export function buildServerlessConnectorParams(): proto.sqlynx_session.pb.ConnectorParams {
    return new proto.sqlynx_session.pb.ConnectorParams({
        connector: {
            case: "serverless",
            value: new proto.sqlynx_session.pb.ServerlessParams()
        }
    });
}
