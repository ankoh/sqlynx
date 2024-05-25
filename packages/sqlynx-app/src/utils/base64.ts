const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export class Base64Codec {
    lookupTable: Uint8Array;

    constructor() {
        // Build a lookup table
        this.lookupTable = new Uint8Array(256);
        this.lookupTable.fill(0xFF);
        for (let i = 0; i < BASE64.length; i++) {
            this.lookupTable[BASE64.charCodeAt(i)] = i;
        }
    }

    /// Encode the ArrayBuffer
    public encode(arraybuffer: ArrayBuffer) {
        const bytes = new Uint8Array(arraybuffer);
        let base64 = "";

        for (let i = 0; i < bytes.length; i += 3) {
            // Upper 6 bits of first bytes
            base64 += BASE64[bytes[i] >> 2];
            // Lower 2 bits of first byte and upper 4 bits of second byte
            base64 += BASE64[((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4)];
            // Lower 4 bits of second byte and upper 2 bits of third byte
            base64 += BASE64[((bytes[i + 1] & 15) << 2) | (bytes[i + 2] >> 6)];
            // Lower 4 bits of third byte
            base64 += BASE64[bytes[i + 2] & 63];
        }
        // Append trailing equals
        if ((bytes.length % 3) === 2) {
            base64 = base64.substring(0, base64.length - 1) + "=";
        } else if (bytes.length % 3 === 1) {
            base64 = base64.substring(0, base64.length - 2) + "==";
        }
        return base64;
    };

    /// Check if the string is a valid base64 sequence
    public isValidBase64(base64: string) {
        let valid = true;
        let dataLength = base64.length;
        if (base64[base64.length - 1] === "=") {
            dataLength--;
            if (base64[base64.length - 2] === "=") {
                dataLength--;
            }
        }
        for (let i = 0; i < dataLength; ++i) {
            const c = base64.charCodeAt(i);
            valid &&= this.lookupTable[c] != 0xFF;
        }
        return valid;
    }

    /// Decode a Base64 string
    public decode(base64: string) {
        // Cut the trailing equal signs
        let bufferLength = base64.length * 0.75;
        if (base64[base64.length - 1] === "=") {
            bufferLength--;
            if (base64[base64.length - 2] === "=") {
                bufferLength--;
            }
        }

        /// Allocate the ArrayBuffer
        const arraybuffer = new ArrayBuffer(bufferLength),
            bytes = new Uint8Array(arraybuffer);

        let writer = 0;
        for (let i = 0; i < base64.length; i += 4) {
            // Read all bytes, storing 6 bits of data each
            const encoded1 = this.lookupTable[base64.charCodeAt(i)];
            const encoded2 = this.lookupTable[base64.charCodeAt(i + 1)];
            const encoded3 = this.lookupTable[base64.charCodeAt(i + 2)];
            const encoded4 = this.lookupTable[base64.charCodeAt(i + 3)];

            // Reconstruct original bytes from 6 bits
            bytes[writer++] = (encoded1 << 2) | (encoded2 >> 4);
            bytes[writer++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
            bytes[writer++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
        }

        return arraybuffer;
    };
};

export const BASE64_CODEC = new Base64Codec();
