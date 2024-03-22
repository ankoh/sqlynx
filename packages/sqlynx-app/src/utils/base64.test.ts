import { BASE64_CODEC } from "./base64.js";
import { cyrb128, randomBuffer32, sfc32T } from "./prng.js";

describe('Base64Codec', () => {
    describe("invalid base64 strings", () => {
        it("padding chars", () => {
            expect(BASE64_CODEC.isValidABase64("uny100A=")).toBeTruthy();
            expect(BASE64_CODEC.isValidABase64("uny100==")).toBeTruthy();
            expect(BASE64_CODEC.isValidABase64("=uny100=")).toBeFalsy();
            expect(BASE64_CODEC.isValidABase64("==uny100")).toBeFalsy();
        })
    });

    describe("encodes random 32 byte sequences", () => {
        for (const seed of ["foo", "bar"]) {
            it(`seed=${seed}`, () => {
                let randomBytes = randomBuffer32(32, sfc32T(cyrb128(seed)))
                let encoded = BASE64_CODEC.encode(randomBytes);
                expect(BASE64_CODEC.isValidABase64(encoded)).toBeTruthy();
                let decoded = BASE64_CODEC.decode(encoded);
                expect(decoded).toEqual(randomBytes);
            });
        }
    });
})
