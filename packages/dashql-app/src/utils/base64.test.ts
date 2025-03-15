import * as proto from '@ankoh/dashql-protobuf';

import { BASE64_CODEC } from "./base64.js";
import { cyrb128, randomBuffer32, sfc32T } from "./prng.js";

describe('Base64Codec', () => {
    describe("invalid base64 strings", () => {
        it("padding chars", () => {
            expect(BASE64_CODEC.isValidBase64("uny100A=")).toBeTruthy();
            expect(BASE64_CODEC.isValidBase64("uny100==")).toBeTruthy();
            expect(BASE64_CODEC.isValidBase64("=uny100=")).toBeFalsy();
            expect(BASE64_CODEC.isValidBase64("==uny100")).toBeFalsy();
        })
    });

    describe("encodes random 32 byte sequences", () => {
        for (const seed of ["foo", "bar"]) {
            it(`seed=${seed}`, () => {
                const randomBytes = randomBuffer32(32, sfc32T(cyrb128(seed)))
                const encoded = BASE64_CODEC.encode(randomBytes);
                expect(BASE64_CODEC.isValidBase64(encoded)).toBeTruthy();
                const decoded = BASE64_CODEC.decode(encoded);
                expect(decoded).toEqual(randomBytes);
            });
        }
    });

    it("encode salesforce oauth web flow state", () => {
        const authState = new proto.dashql_oauth.pb.OAuthState({
            flowVariant: proto.dashql_oauth.pb.OAuthFlowVariant.WEB_OPENER_FLOW,
            providerOptions: {
                case: "salesforceProvider",
                value: new proto.dashql_oauth.pb.SalesforceOAuthOptions({
                    instanceUrl: "https://trialorgfarmforu-16f.test2.my.pc-rnd.salesforce.com",
                    appConsumerKey: "foo",
                }),
            }
        });
        const authStateBuffer = authState.toBinary();
        const authStateBase64 = BASE64_CODEC.encode(authStateBuffer.buffer);
        expect(authStateBase64).toEqual("EAEaQgo7aHR0cHM6Ly90cmlhbG9yZ2Zhcm1mb3J1LTE2Zi50ZXN0Mi5teS5wYy1ybmQuc2FsZXNmb3JjZS5jb20SA2Zvbw==");
    });

    it("encode salesforce oauth native flow state", () => {
        const authState = new proto.dashql_oauth.pb.OAuthState({
            flowVariant: proto.dashql_oauth.pb.OAuthFlowVariant.NATIVE_LINK_FLOW,
            providerOptions: {
                case: "salesforceProvider",
                value: new proto.dashql_oauth.pb.SalesforceOAuthOptions({
                    instanceUrl: "https://trialorgfarmforu-16f.test2.my.pc-rnd.salesforce.com",
                    appConsumerKey: "foo"
                }),
            }
        });
        const authStateBuffer = authState.toBinary();
        const authStateBase64 = BASE64_CODEC.encode(authStateBuffer.buffer);
        expect(authStateBase64).toEqual("EAIaQgo7aHR0cHM6Ly90cmlhbG9yZ2Zhcm1mb3J1LTE2Zi50ZXN0Mi5teS5wYy1ybmQuc2FsZXNmb3JjZS5jb20SA2Zvbw==");
    });
})
