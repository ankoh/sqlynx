import { describe, it, expect } from 'vitest';
import * as buf from "@bufbuild/protobuf";
import * as wkt from "@bufbuild/protobuf/wkt";
import * as pb from "../../../../proto.js";

import {
    decodeGrpcStatusDetails,
    decodeGrpcErrorHeaders,
    fromHttpErrorResponse,
    hyperErrorInfoToKeyValues,
    HEADER_GRPC_MESSAGE,
    HEADER_GRPC_STATUS,
    HEADER_GRPC_STATUS_DETAILS,
} from './hyper_error_info.js';

/// Build a base64-encoded google.rpc.Status carrying a packed ErrorInfo,
/// matching what the native proxy forwards in the status-details-bin header.
function encodeStatusWithErrorInfo(code: number, message: string, info: Partial<{
    primaryMessage: string;
    sqlstate: string;
    customerHint: string;
    customerDetail: string;
    systemDetail: string;
    errorSource: string;
    position: { begin: number; end: number };
}>): string {
    const errorInfo = buf.create(pb.salesforce_hyperdb_grpc_v1.error_details.ErrorInfoSchema, {
        primaryMessage: info.primaryMessage ?? "",
        sqlstate: info.sqlstate ?? "",
        customerHint: info.customerHint ?? "",
        customerDetail: info.customerDetail ?? "",
        systemDetail: info.systemDetail ?? "",
        errorSource: info.errorSource ?? "",
        position: info.position
            ? buf.create(pb.salesforce_hyperdb_grpc_v1.error_details.TextPositionSchema, {
                errorBeginCharacterOffset: BigInt(info.position.begin),
                errorEndCharacterOffset: BigInt(info.position.end),
            })
            : undefined,
    });
    const any = wkt.anyPack(pb.salesforce_hyperdb_grpc_v1.error_details.ErrorInfoSchema, errorInfo);
    const status = buf.create(pb.google_rpc.status.StatusSchema, {
        code,
        message,
        details: [any],
    });
    const bytes = buf.toBinary(pb.google_rpc.status.StatusSchema, status);
    let binary = "";
    for (let i = 0; i < bytes.length; ++i) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

describe('hyper_error_info', () => {
    describe('decodeGrpcStatusDetails', () => {
        it('unpacks a packed ErrorInfo with all fields', () => {
            const encoded = encodeStatusWithErrorInfo(3, "invalid query", {
                primaryMessage: "syntax error at end of input",
                sqlstate: "42601",
                customerHint: "check your SQL",
                customerDetail: "unexpected EOF",
                systemDetail: "parser failed in production stmt",
                errorSource: "User",
                position: { begin: 7, end: 12 },
            });
            const info = decodeGrpcStatusDetails(encoded, 3);
            expect(info).not.toBeNull();
            expect(info!.primaryMessage).toBe("syntax error at end of input");
            expect(info!.sqlstate).toBe("42601");
            expect(info!.customerHint).toBe("check your SQL");
            expect(info!.customerDetail).toBe("unexpected EOF");
            expect(info!.systemDetail).toBe("parser failed in production stmt");
            expect(info!.errorSource).toBe("User");
            expect(info!.position).toEqual({ beginCharacterOffset: 7, endCharacterOffset: 12 });
            expect(info!.grpcStatusCode).toBe(3);
        });

        it('normalizes an unknown error source', () => {
            const encoded = encodeStatusWithErrorInfo(13, "boom", {
                primaryMessage: "boom",
                errorSource: "somethingelse",
            });
            const info = decodeGrpcStatusDetails(encoded);
            expect(info!.errorSource).toBe("Unknown");
        });

        it('leaves optional empty fields undefined', () => {
            const encoded = encodeStatusWithErrorInfo(3, "m", { primaryMessage: "m" });
            const info = decodeGrpcStatusDetails(encoded);
            expect(info!.sqlstate).toBeUndefined();
            expect(info!.customerHint).toBeUndefined();
            expect(info!.position).toBeUndefined();
        });

        it('returns null for invalid base64/proto', () => {
            expect(decodeGrpcStatusDetails("not-valid-base64!!!")).toBeNull();
        });
    });

    describe('decodeGrpcErrorHeaders', () => {
        it('decodes the status-details-bin header', () => {
            const encoded = encodeStatusWithErrorInfo(3, "m", {
                primaryMessage: "primary",
                sqlstate: "42601",
            });
            const headers = new Headers();
            headers.set(HEADER_GRPC_STATUS, "3");
            headers.set(HEADER_GRPC_STATUS_DETAILS, encoded);
            const info = decodeGrpcErrorHeaders(headers);
            expect(info!.primaryMessage).toBe("primary");
            expect(info!.grpcStatusCode).toBe(3);
        });

        it('falls back to the terse grpc-message when no details present', () => {
            const headers = new Headers();
            headers.set(HEADER_GRPC_STATUS, "14");
            headers.set(HEADER_GRPC_MESSAGE, "unavailable");
            const info = decodeGrpcErrorHeaders(headers);
            expect(info!.primaryMessage).toBe("unavailable");
            expect(info!.errorSource).toBe("Unknown");
            expect(info!.grpcStatusCode).toBe(14);
        });

        it('returns null when there is no error data', () => {
            expect(decodeGrpcErrorHeaders(new Headers())).toBeNull();
            expect(decodeGrpcErrorHeaders(null)).toBeNull();
        });
    });

    describe('fromHttpErrorResponse', () => {
        it('maps the v3 JSON error body', () => {
            const info = fromHttpErrorResponse({
                error: "INVALID_ARGUMENT",
                message: "syntax error",
                details: {
                    customerHint: "fix it",
                    customerDetail: "near 'slect'",
                    errorSource: "User",
                    position: {
                        errorBeginCharacterOffset: "0",
                        errorEndCharacterOffset: "5",
                    },
                },
            });
            expect(info.primaryMessage).toBe("syntax error");
            expect(info.customerHint).toBe("fix it");
            expect(info.customerDetail).toBe("near 'slect'");
            expect(info.errorSource).toBe("User");
            expect(info.position).toEqual({ beginCharacterOffset: 0, endCharacterOffset: 5 });
        });

        it('falls back to the error code when message is empty', () => {
            const info = fromHttpErrorResponse({ error: "INTERNAL", message: "" });
            expect(info.primaryMessage).toBe("INTERNAL");
            expect(info.errorSource).toBe("Unknown");
        });
    });

    describe('hyperErrorInfoToKeyValues', () => {
        it('only includes populated fields', () => {
            const kv = hyperErrorInfoToKeyValues({
                primaryMessage: "m",
                sqlstate: "42601",
                errorSource: "User",
                position: { beginCharacterOffset: 1, endCharacterOffset: 2 },
            });
            expect(kv).toEqual({
                sqlstate: "42601",
                source: "User",
                position: "1..2",
            });
        });

        it('omits an unknown source', () => {
            const kv = hyperErrorInfoToKeyValues({ primaryMessage: "m", errorSource: "Unknown" });
            expect(kv).toEqual({});
        });
    });
});
