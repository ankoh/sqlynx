import * as buf from "@bufbuild/protobuf";
import * as wkt from "@bufbuild/protobuf/wkt";
import * as pb from "../../../../proto.js";

import { LoggableException } from "../../../../platform/logger/logger.js";
import { QueryErrorResponse } from "./hyperdb_http_client.js";

/// The gRPC "richer error model" trailer that carries the base64-encoded
/// google.rpc.Status. This is the same name the wire uses, mirrored by the
/// native proxy (see proxy_headers.rs HEADER_NAME_GRPC_STATUS_DETAILS).
export const HEADER_GRPC_STATUS_DETAILS = "dashql-grpc-status-details-bin";
/// The terse gRPC status message forwarded by the native proxy.
export const HEADER_GRPC_MESSAGE = "dashql-grpc-message";
/// The numeric gRPC status code forwarded by the native proxy.
export const HEADER_GRPC_STATUS = "dashql-grpc-status";

/// A text position into the user-provided SQL text.
/// Offsets are measured in unicode code points.
export interface HyperTextPosition {
    /// Start offset
    beginCharacterOffset: number;
    /// End offset
    endCharacterOffset: number;
}

/// The origin of an error, as classified by Hyper.
export type HyperErrorSource = "User" | "System" | "Unknown";

/// A structured, transport-independent view of Hyper's rich error model.
///
/// Both the native gRPC path (via the `grpc-status-details-bin` trailer) and
/// the web HTTP v3 path (via the JSON error body) are decoded into this shape
/// so the rest of the app has a single error representation.
export interface HyperErrorInfo {
    /// The primary (terse) error message
    primaryMessage: string;
    /// The SQL state error code (empty means "unknown / internal error")
    sqlstate?: string;
    /// A suggestion on what to do about the problem
    customerHint?: string;
    /// Error detail with customer data classification
    customerDetail?: string;
    /// Error detail with system data classification
    systemDetail?: string;
    /// Position information pertaining to the error in the SQL text
    position?: HyperTextPosition;
    /// The cause of the error
    errorSource: HyperErrorSource;
    /// The numeric gRPC status code, if the error came from a gRPC call
    grpcStatusCode?: number;
}

function normalizeErrorSource(raw: string | undefined): HyperErrorSource {
    switch (raw) {
        case "User":
            return "User";
        case "System":
            return "System";
        default:
            return "Unknown";
    }
}

/// Convert a decoded protobuf ErrorInfo into our structured HyperErrorInfo.
function fromProtoErrorInfo(info: pb.salesforce_hyperdb_grpc_v1.error_details.ErrorInfo, grpcStatusCode?: number): HyperErrorInfo {
    const position = info.position
        ? {
            beginCharacterOffset: Number(info.position.errorBeginCharacterOffset),
            endCharacterOffset: Number(info.position.errorEndCharacterOffset),
        }
        : undefined;
    return {
        primaryMessage: info.primaryMessage,
        sqlstate: info.sqlstate || undefined,
        customerHint: info.customerHint || undefined,
        customerDetail: info.customerDetail || undefined,
        systemDetail: info.systemDetail || undefined,
        position,
        errorSource: normalizeErrorSource(info.errorSource),
        grpcStatusCode,
    };
}

/// Decode a base64-encoded google.rpc.Status (the `grpc-status-details-bin`
/// trailer) and unpack the first packed Hyper ErrorInfo, if any.
export function decodeGrpcStatusDetails(base64Details: string, grpcStatusCode?: number): HyperErrorInfo | null {
    let bytes: Uint8Array;
    try {
        const binary = atob(base64Details);
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; ++i) {
            bytes[i] = binary.charCodeAt(i);
        }
    } catch {
        return null;
    }

    let status: pb.google_rpc.status.Status;
    try {
        status = buf.fromBinary(pb.google_rpc.status.StatusSchema, bytes);
    } catch {
        return null;
    }

    // Find the ErrorInfo packed into the repeated Any `details`.
    for (const detail of status.details) {
        if (wkt.anyIs(detail, pb.salesforce_hyperdb_grpc_v1.error_details.ErrorInfoSchema)) {
            const info = wkt.anyUnpack(detail, pb.salesforce_hyperdb_grpc_v1.error_details.ErrorInfoSchema);
            if (info) {
                return fromProtoErrorInfo(info, grpcStatusCode);
            }
        }
    }

    // No ErrorInfo packed: fall back to the plain google.rpc.Status message.
    if (status.message) {
        return {
            primaryMessage: status.message,
            errorSource: "Unknown",
            grpcStatusCode: grpcStatusCode ?? status.code,
        };
    }
    return null;
}

/// Extract a HyperErrorInfo from response headers/trailers forwarded by the
/// native gRPC proxy. Returns null if no rich error data is present.
export function decodeGrpcErrorHeaders(headers: Headers | null | undefined): HyperErrorInfo | null {
    if (!headers) {
        return null;
    }
    const rawStatus = headers.get(HEADER_GRPC_STATUS);
    const grpcStatusCode = rawStatus != null ? Number.parseInt(rawStatus) : undefined;

    const details = headers.get(HEADER_GRPC_STATUS_DETAILS);
    if (details) {
        const decoded = decodeGrpcStatusDetails(details, grpcStatusCode);
        if (decoded) {
            return decoded;
        }
    }

    // No status-details-bin: fall back to the terse grpc-message.
    const message = headers.get(HEADER_GRPC_MESSAGE);
    if (message) {
        return {
            primaryMessage: message,
            errorSource: "Unknown",
            grpcStatusCode,
        };
    }
    return null;
}

/// Flatten a HyperErrorInfo into a string key/value map for logging and for
/// the generic error-details viewer. Only non-empty fields are included, and
/// `system_detail` is included because these logs stay client-side.
export function hyperErrorInfoToKeyValues(info: HyperErrorInfo): Record<string, string> {
    const kv: Record<string, string> = {};
    if (info.sqlstate) kv["sqlstate"] = info.sqlstate;
    if (info.errorSource !== "Unknown") kv["source"] = info.errorSource;
    if (info.customerHint) kv["hint"] = info.customerHint;
    if (info.customerDetail) kv["detail"] = info.customerDetail;
    if (info.systemDetail) kv["systemDetail"] = info.systemDetail;
    if (info.grpcStatusCode != null) kv["grpcStatus"] = info.grpcStatusCode.toString();
    if (info.position) {
        kv["position"] = `${info.position.beginCharacterOffset}..${info.position.endCharacterOffset}`;
    }
    return kv;
}

/// An error raised for a failed Hyper query, carrying the decoded rich error
/// model. Both the native gRPC path and the web HTTP v3 path raise this so the
/// rest of the app has a single, structured error type.
export class HyperQueryError extends LoggableException {
    /// The decoded rich error info
    readonly info: HyperErrorInfo;

    constructor(info: HyperErrorInfo, target?: string) {
        super(info.primaryMessage, hyperErrorInfoToKeyValues(info), target);
        this.info = info;
    }
}

/// Map the web HTTP v3 JSON error body into a HyperErrorInfo.
export function fromHttpErrorResponse(response: QueryErrorResponse): HyperErrorInfo {
    const details = response.details;
    const position = details?.position
        ? {
            beginCharacterOffset: Number.parseInt(details.position.errorBeginCharacterOffset),
            endCharacterOffset: Number.parseInt(details.position.errorEndCharacterOffset),
        }
        : undefined;
    return {
        primaryMessage: response.message || response.error,
        customerHint: details?.customerHint || undefined,
        customerDetail: details?.customerDetail || undefined,
        position,
        errorSource: normalizeErrorSource(details?.errorSource),
    };
}
