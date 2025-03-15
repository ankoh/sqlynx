import { Int128, UInt128, Decimal128 } from './int128.js';

describe('Int128', () => {
    it("codec", () => {
        const test = (v: bigint) =>
            expect(Int128.decodeLE(Int128.encodeLE(v))).toEqual(v);
        test(BigInt(0));
        test(BigInt(1));
        test(BigInt(1) * BigInt(1000000));
        test(BigInt(1) * BigInt(1e18));
        test(BigInt(-1) * BigInt(1000000));
        test(BigInt(-1) * BigInt(1e18));
    });
});

describe('UInt128', () => {
    it("codec", () => {
        const test = (v: bigint) =>
            expect(UInt128.decodeLE(UInt128.encodeLE(v))).toEqual(v);
        test(BigInt(0));
        test(BigInt(1));
        test(BigInt(1) * BigInt(1000000));
        test(BigInt(1) * BigInt(1e18));
    });
});

describe('Decimal', () => {
    it("format", () => {
        expect(Decimal128.format(42n * BigInt(1e18), 18).toString()).toEqual("42");
        expect(Decimal128.format(10n * BigInt(1e18) + 5n * BigInt(1e17), 18).toString()).toEqual("10.5");
    })
});
