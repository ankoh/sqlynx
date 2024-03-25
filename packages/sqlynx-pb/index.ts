import * as salesforce_hyperdb_grpc_v1_pb_ from './gen/salesforce/hyperdb/grpc/v1/hyper_service_pb';
import * as salesforce_hyperdb_grpc_v1_grpc_ from './gen/salesforce/hyperdb/grpc/v1/hyper_service_connect';
import * as sqlynx_oauth_pb_ from './gen/sqlynx/oauth_pb';
import * as sqlynx_app_event_pb_ from './gen/sqlynx/app_event_pb';

export namespace salesforce_hyperdb_grpc_v1 {
    export import pb = salesforce_hyperdb_grpc_v1_pb_;
    export import grpc = salesforce_hyperdb_grpc_v1_grpc_;
}

export namespace sqlynx_oauth {
    export import pb = sqlynx_oauth_pb_;
}

export namespace sqlynx_app_event {
    export import pb = sqlynx_app_event_pb_;
}
