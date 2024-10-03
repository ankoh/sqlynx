// PRNGs taken from here: https://stackoverflow.com/questions/521295/seeding-the-random-number-generator-in-javascript

export function cyrb128(v: number) {
    let h1 = 1779033703,
        h2 = 3144134277,
        h3 = 1013904242,
        h4 = 2773480762;
    h1 = h2 ^ Math.imul(h1 ^ v, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ v, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ v, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ v, 2716044179);
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

export function xoshiro128ss(a: number, b: number, c: number, d: number) {
    return () => {
        let t = b << 9,
            r = b * 5;
        r = ((r << 7) | (r >>> 25)) * 9;
        c ^= a;
        d ^= b;
        b ^= c;
        a ^= d;
        c ^= t;
        d = (d << 11) | (d >>> 21);
        return (r >>> 0) / 4294967296;
    };
}
