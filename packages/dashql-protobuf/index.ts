import * as salesforce_hyperdb_grpc_v1_pb_ from './gen/salesforce/hyperdb/grpc/v1/hyper_service_pb.js';
import * as salesforce_hyperdb_grpc_v1_grpc_ from './gen/salesforce/hyperdb/grpc/v1/hyper_service_connect.js';
import * as dashql_app_event_pb_ from './gen/dashql/app_event_pb.js';
import * as dashql_catalog_pb_ from './gen/dashql/catalog_pb.js';
import * as dashql_compute_pb_ from './gen/dashql/compute/compute_pb.js';
import * as dashql_connection_pb_ from './gen/dashql/connection_pb.js';
import * as dashql_file_pb_ from './gen/dashql/file_pb.js';
import * as dashql_oauth_pb_ from './gen/dashql/oauth_pb.js';
import * as dashql_workbook_pb_ from './gen/dashql/workbook_pb.js';

export namespace salesforce_hyperdb_grpc_v1 {
    export import pb = salesforce_hyperdb_grpc_v1_pb_;
    export import grpc = salesforce_hyperdb_grpc_v1_grpc_;
}

export namespace dashql {
    export import oauth = dashql_oauth_pb_;
    export import workbook = dashql_workbook_pb_;
    export import connection = dashql_connection_pb_;
    export import catalog = dashql_catalog_pb_;
    export import file = dashql_file_pb_;
    export import app_event = dashql_app_event_pb_;
    export import compute = dashql_compute_pb_;
}
