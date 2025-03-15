const Int128Min = -170141183460469231731687303715884105728n;
const Int128Max = 170141183460469231731687303715884105727n;
const UInt128Max = 340282366920938463463374607431768211455n;

export class Int128 {
    static encodeLE(v: bigint) {
        if (v < Int128Min || v > Int128Max) throw Error("Input has to be between -(2^127) and (2^127)-1");

        const biguint = BigInt.asUintN(128, v);
        const buf = new ArrayBuffer(16);
        const bufView = new DataView(buf, 0, 16);
        bufView.setBigUint64(0, biguint & 0xffffffffffffffffn, true);
        bufView.setBigUint64(8, biguint >> 64n, true);
        return new Uint32Array(buf);
    }

    static decodeLE(buf: Uint32Array, offset = 0) {
        if (buf.byteLength < (offset + 16)) throw Error("Buffer out of range.");

        const bufView = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        let biguint = bufView.getBigUint64(offset, true);
        biguint |= bufView.getBigUint64(offset + 8, true) << 64n;
        return BigInt.asIntN(128, biguint);
    }
}

export class UInt128 {
    static encodeLE(v: bigint) {
        if (v < 0n || v > UInt128Max) throw Error("Input has to be between 0 and (2^128)-1");

        const buf = new ArrayBuffer(16);
        const bufView = new DataView(buf, 0, 16);
        bufView.setBigUint64(0, v & 0xffffffffffffffffn, true);
        bufView.setBigUint64(8, v >> 64n, true);
        return new Uint32Array(buf);
    }

    static decodeLE(buf: Uint32Array, offset = 0) {
        if (buf.byteLength < (offset + 16)) throw Error("Buffer out of range.");

        const bufView = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        let biguint = bufView.getBigUint64(offset, true);
        biguint |= bufView.getBigUint64(offset + 8, true) << 64n;
        return biguint;
    }
}

export class Decimal128 {
    static format(num: bigint, scale: number) {
        // Get int part
        const factor = BigInt(Math.pow(10, scale));
        const intPart = num / factor;
        // Get fraction part
        let fractionPart = num - (intPart * factor);
        if (fractionPart < 0n) fractionPart = ~fractionPart;
        const fractionStr = fractionPart.toString();

        // Cut trailing zeros
        let end = fractionStr.length;
        for (; end > 0 && fractionStr.charCodeAt(end - 1) == 0x30; --end);

        // Render with or without decimal dot
        if (end == 0) {
            return `${intPart.toString()}`;
        } else {
            return `${intPart.toString()}.${fractionStr.substring(0, end)}`;
        }
    }
}
