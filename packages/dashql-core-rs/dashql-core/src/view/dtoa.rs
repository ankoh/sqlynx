//! Double to text as rapidjson 1.1.0 writes it (`internal/dtoa.h`, `internal/diyfp.h`): Grisu2 digits and the
//! rapidjson prettifier.
//!
//! Grisu2 does not always find the shortest representation, so `{}` formatting differs for some values. The
//! arithmetic is mirrored step by step, including the unsigned wrap-around of the C++ code.

/// The number of significand bits of a double (without the hidden bit)
const DP_SIGNIFICAND_SIZE: i32 = 52;
/// The exponent bias of a double, including the significand shift
const DP_EXPONENT_BIAS: i32 = 0x3FF + DP_SIGNIFICAND_SIZE;
/// The minimum exponent of a double
const DP_MIN_EXPONENT: i32 = -DP_EXPONENT_BIAS;
/// The exponent mask of a double
const DP_EXPONENT_MASK: u64 = 0x7FF0_0000_0000_0000;
/// The significand mask of a double
const DP_SIGNIFICAND_MASK: u64 = 0x000F_FFFF_FFFF_FFFF;
/// The hidden bit of a double
const DP_HIDDEN_BIT: u64 = 0x0010_0000_0000_0000;
/// The sign mask of a double
const DP_SIGN_MASK: u64 = 0x8000_0000_0000_0000;

/// Is a double NaN or infinite? (`internal::Double::IsNanOrInf`)
pub fn is_nan_or_inf(d: f64) -> bool {
    (d.to_bits() & DP_EXPONENT_MASK) == DP_EXPONENT_MASK
}

/// A floating point number with a 64 bit significand (`internal::DiyFp`)
#[derive(Clone, Copy, Debug)]
struct DiyFp {
    f: u64,
    e: i32,
}

impl DiyFp {
    fn new(f: u64, e: i32) -> Self {
        Self { f, e }
    }

    fn from_double(d: f64) -> Self {
        let u = d.to_bits();
        let biased_e = ((u & DP_EXPONENT_MASK) >> DP_SIGNIFICAND_SIZE) as i32;
        let significand = u & DP_SIGNIFICAND_MASK;
        if biased_e != 0 {
            Self::new(significand + DP_HIDDEN_BIT, biased_e - DP_EXPONENT_BIAS)
        } else {
            Self::new(significand, DP_MIN_EXPONENT + 1)
        }
    }

    fn sub(self, rhs: DiyFp) -> DiyFp {
        DiyFp::new(self.f.wrapping_sub(rhs.f), self.e)
    }

    fn mul(self, rhs: DiyFp) -> DiyFp {
        // Equals both the __int128 and the portable 32 bit path of rapidjson
        let p = (self.f as u128) * (rhs.f as u128);
        let mut h = (p >> 64) as u64;
        let l = p as u64;
        if l & (1u64 << 63) != 0 {
            h = h.wrapping_add(1);
        }
        DiyFp::new(h, self.e + rhs.e + 64)
    }

    fn normalize(self) -> DiyFp {
        let s = self.f.leading_zeros() as i32;
        DiyFp::new(self.f << s, self.e - s)
    }

    fn normalize_boundary(self) -> DiyFp {
        let mut res = self;
        while res.f & (DP_HIDDEN_BIT << 1) == 0 {
            res.f <<= 1;
            res.e -= 1;
        }
        res.f <<= 64 - DP_SIGNIFICAND_SIZE - 2;
        res.e -= 64 - DP_SIGNIFICAND_SIZE - 2;
        res
    }

    fn normalized_boundaries(self) -> (DiyFp, DiyFp) {
        let pl = DiyFp::new((self.f << 1) + 1, self.e - 1).normalize_boundary();
        let mut mi = if self.f == DP_HIDDEN_BIT {
            DiyFp::new((self.f << 2) - 1, self.e - 2)
        } else {
            DiyFp::new((self.f << 1) - 1, self.e - 1)
        };
        mi.f <<= mi.e - pl.e;
        mi.e = pl.e;
        (mi, pl)
    }
}

/// 10^-348, 10^-340, ..., 10^340 (`GetCachedPowerByIndex`)
static CACHED_POWERS_F: [u64; 87] = [
    0xfa8fd5a0081c0288, 0xbaaee17fa23ebf76, 0x8b16fb203055ac76, 0xcf42894a5dce35ea, 0x9a6bb0aa55653b2d,
    0xe61acf033d1a45df, 0xab70fe17c79ac6ca, 0xff77b1fcbebcdc4f, 0xbe5691ef416bd60c, 0x8dd01fad907ffc3c,
    0xd3515c2831559a83, 0x9d71ac8fada6c9b5, 0xea9c227723ee8bcb, 0xaecc49914078536d, 0x823c12795db6ce57,
    0xc21094364dfb5637, 0x9096ea6f3848984f, 0xd77485cb25823ac7, 0xa086cfcd97bf97f4, 0xef340a98172aace5,
    0xb23867fb2a35b28e, 0x84c8d4dfd2c63f3b, 0xc5dd44271ad3cdba, 0x936b9fcebb25c996, 0xdbac6c247d62a584,
    0xa3ab66580d5fdaf6, 0xf3e2f893dec3f126, 0xb5b5ada8aaff80b8, 0x87625f056c7c4a8b, 0xc9bcff6034c13053,
    0x964e858c91ba2655, 0xdff9772470297ebd, 0xa6dfbd9fb8e5b88f, 0xf8a95fcf88747d94, 0xb94470938fa89bcf,
    0x8a08f0f8bf0f156b, 0xcdb02555653131b6, 0x993fe2c6d07b7fac, 0xe45c10c42a2b3b06, 0xaa242499697392d3,
    0xfd87b5f28300ca0e, 0xbce5086492111aeb, 0x8cbccc096f5088cc, 0xd1b71758e219652c, 0x9c40000000000000,
    0xe8d4a51000000000, 0xad78ebc5ac620000, 0x813f3978f8940984, 0xc097ce7bc90715b3, 0x8f7e32ce7bea5c70,
    0xd5d238a4abe98068, 0x9f4f2726179a2245, 0xed63a231d4c4fb27, 0xb0de65388cc8ada8, 0x83c7088e1aab65db,
    0xc45d1df942711d9a, 0x924d692ca61be758, 0xda01ee641a708dea, 0xa26da3999aef774a, 0xf209787bb47d6b85,
    0xb454e4a179dd1877, 0x865b86925b9bc5c2, 0xc83553c5c8965d3d, 0x952ab45cfa97a0b3, 0xde469fbd99a05fe3,
    0xa59bc234db398c25, 0xf6c69a72a3989f5c, 0xb7dcbf5354e9bece, 0x88fcf317f22241e2, 0xcc20ce9bd35c78a5,
    0x98165af37b2153df, 0xe2a0b5dc971f303a, 0xa8d9d1535ce3b396, 0xfb9b7cd9a4a7443c, 0xbb764c4ca7a44410,
    0x8bab8eefb6409c1a, 0xd01fef10a657842c, 0x9b10a4e5e9913129, 0xe7109bfba19c0c9d, 0xac2820d9623bf429,
    0x80444b5e7aa7cf85, 0xbf21e44003acdd2d, 0x8e679c2f5e44ff8f, 0xd433179d9c8cb841, 0x9e19db92b4e31ba9,
    0xeb96bf6ebadf77d9, 0xaf87023b9bf0ee6b,
];
static CACHED_POWERS_E: [i16; 87] = [
    -1220, -1193, -1166, -1140, -1113, -1087, -1060, -1034, -1007, -980, -954, -927, -901, -874, -847, -821, -794,
    -768, -741, -715, -688, -661, -635, -608, -582, -555, -529, -502, -475, -449, -422, -396, -369, -343, -316,
    -289, -263, -236, -210, -183, -157, -130, -103, -77, -50, -24, 3, 30, 56, 83, 109, 136, 162, 189, 216, 242, 269,
    295, 322, 348, 375, 402, 428, 455, 481, 508, 534, 561, 588, 614, 641, 667, 694, 720, 747, 774, 800, 827, 853, 880,
    907, 933, 960, 986, 1013, 1039, 1066,
];

/// `GetCachedPower`
fn get_cached_power(e: i32, k_out: &mut i32) -> DiyFp {
    let dk = (-61 - e) as f64 * 0.30102999566398114 + 347.0;
    let mut k = dk as i32;
    if dk - k as f64 > 0.0 {
        k += 1;
    }
    let index = ((k >> 3) + 1) as u32;
    *k_out = -(-348 + (index << 3) as i32);
    DiyFp::new(CACHED_POWERS_F[index as usize], CACHED_POWERS_E[index as usize] as i32)
}

static POW10_U32: [u32; 10] = [1, 10, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000, 1000000000];

fn grisu_round(buffer: &mut [u8], len: usize, delta: u64, mut rest: u64, ten_kappa: u64, wp_w: u64) {
    while rest < wp_w
        && delta.wrapping_sub(rest) >= ten_kappa
        && (rest.wrapping_add(ten_kappa) < wp_w
            || wp_w.wrapping_sub(rest) > rest.wrapping_add(ten_kappa).wrapping_sub(wp_w))
    {
        buffer[len - 1] = buffer[len - 1].wrapping_sub(1);
        rest = rest.wrapping_add(ten_kappa);
    }
}

fn count_decimal_digit32(n: u32) -> u32 {
    match n {
        0..=9 => 1,
        10..=99 => 2,
        100..=999 => 3,
        1000..=9999 => 4,
        10000..=99999 => 5,
        100000..=999999 => 6,
        1000000..=9999999 => 7,
        10000000..=99999999 => 8,
        _ => 9,
    }
}

fn digit_gen(w: DiyFp, mp: DiyFp, mut delta: u64, buffer: &mut [u8], len: &mut usize, k: &mut i32) {
    let one = DiyFp::new(1u64 << -mp.e, mp.e);
    let wp_w = mp.sub(w);
    let mut p1 = (mp.f >> -one.e) as u32;
    let mut p2 = mp.f & (one.f - 1);
    let mut kappa: u32 = count_decimal_digit32(p1);
    *len = 0;

    while kappa > 0 {
        let d = match kappa {
            1 => {
                let d = p1;
                p1 = 0;
                d
            }
            2..=9 => {
                let divisor = POW10_U32[kappa as usize - 1];
                let d = p1 / divisor;
                p1 %= divisor;
                d
            }
            _ => 0,
        };
        if d != 0 || *len != 0 {
            buffer[*len] = b'0' + d as u8;
            *len += 1;
        }
        kappa -= 1;
        let tmp = ((p1 as u64) << -one.e).wrapping_add(p2);
        if tmp <= delta {
            *k = k.wrapping_add(kappa as i32);
            grisu_round(buffer, *len, delta, tmp, (POW10_U32[kappa as usize] as u64) << -one.e, wp_w.f);
            return;
        }
    }

    // kappa = 0
    loop {
        p2 = p2.wrapping_mul(10);
        delta = delta.wrapping_mul(10);
        let d = (p2 >> -one.e) as u8;
        if d != 0 || *len != 0 {
            buffer[*len] = b'0'.wrapping_add(d);
            *len += 1;
        }
        p2 &= one.f - 1;
        kappa = kappa.wrapping_sub(1);
        if p2 < delta {
            *k = k.wrapping_add(kappa as i32);
            let index = -(kappa as i32);
            let scale = if index < 9 { POW10_U32[index as usize] as u64 } else { 0 };
            grisu_round(buffer, *len, delta, p2, one.f, wp_w.f.wrapping_mul(scale));
            return;
        }
    }
}

fn grisu2(value: f64, buffer: &mut [u8], length: &mut usize, k: &mut i32) {
    let v = DiyFp::from_double(value);
    let (w_m, w_p) = v.normalized_boundaries();
    let c_mk = get_cached_power(w_p.e, k);
    let w = v.normalize().mul(c_mk);
    let mut wp = w_p.mul(c_mk);
    let mut wm = w_m.mul(c_mk);
    wm.f = wm.f.wrapping_add(1);
    wp.f = wp.f.wrapping_sub(1);
    digit_gen(w, wp, wp.f.wrapping_sub(wm.f), buffer, length, k);
}

/// The two digit lookup of `GetDigitsLut`
fn push_two_digits(out: &mut Vec<u8>, k: i32) {
    out.push(b'0' + (k / 10) as u8);
    out.push(b'0' + (k % 10) as u8);
}

fn write_exponent(mut k: i32, out: &mut Vec<u8>) {
    if k < 0 {
        out.push(b'-');
        k = -k;
    }
    if k >= 100 {
        out.push(b'0' + (k / 100) as u8);
        k %= 100;
        push_two_digits(out, k);
    } else if k >= 10 {
        push_two_digits(out, k);
    } else {
        out.push(b'0' + k as u8);
    }
}

/// `Prettify`: `buffer[..length]` holds the digits, `k` the decimal exponent
fn prettify(buffer: &[u8], length: i32, k: i32, max_decimal_places: i32, out: &mut Vec<u8>) {
    let digits = &buffer[..length as usize];
    let kk = length + k; // 10^(kk-1) <= v < 10^kk

    if 0 <= k && kk <= 21 {
        // 1234e7 -> 12340000000
        out.extend_from_slice(digits);
        out.extend(std::iter::repeat(b'0').take((kk - length) as usize));
        out.extend_from_slice(b".0");
    } else if 0 < kk && kk <= 21 {
        // 1234e-2 -> 12.34
        let mut buf = Vec::with_capacity(length as usize + 1);
        buf.extend_from_slice(&digits[..kk as usize]);
        buf.push(b'.');
        buf.extend_from_slice(&digits[kk as usize..]);
        if 0 > k + max_decimal_places {
            // Remove extra trailing zeros (at least one) after truncation.
            let mut i = kk + max_decimal_places;
            while i > kk + 1 {
                if buf[i as usize] != b'0' {
                    out.extend_from_slice(&buf[..i as usize + 1]);
                    return;
                }
                i -= 1;
            }
            out.extend_from_slice(&buf[..kk as usize + 2]);
        } else {
            out.extend_from_slice(&buf[..length as usize + 1]);
        }
    } else if -6 < kk && kk <= 0 {
        // 1234e-6 -> 0.001234
        let offset = 2 - kk;
        let mut buf = Vec::with_capacity((length + offset) as usize);
        buf.extend_from_slice(b"0.");
        buf.extend(std::iter::repeat(b'0').take((offset - 2) as usize));
        buf.extend_from_slice(digits);
        if length - kk > max_decimal_places {
            // Remove extra trailing zeros (at least one) after truncation.
            let mut i = max_decimal_places + 1;
            while i > 2 {
                if buf[i as usize] != b'0' {
                    out.extend_from_slice(&buf[..i as usize + 1]);
                    return;
                }
                i -= 1;
            }
            out.extend_from_slice(&buf[..3]);
        } else {
            out.extend_from_slice(&buf[..(length + offset) as usize]);
        }
    } else if kk < -max_decimal_places {
        // Truncate to zero
        out.extend_from_slice(b"0.0");
    } else if length == 1 {
        // 1e30
        out.push(digits[0]);
        out.push(b'e');
        write_exponent(kk - 1, out);
    } else {
        // 1234e30 -> 1.234e33
        out.push(digits[0]);
        out.push(b'.');
        out.extend_from_slice(&digits[1..]);
        out.push(b'e');
        write_exponent(kk - 1, out);
    }
}

/// `internal::dtoa` with the default of 324 decimal places. `value` must not be NaN or infinite.
pub fn dtoa(mut value: f64, out: &mut Vec<u8>) {
    const MAX_DECIMAL_PLACES: i32 = 324;
    let bits = value.to_bits();
    if bits & (DP_EXPONENT_MASK | DP_SIGNIFICAND_MASK) == 0 {
        if bits & DP_SIGN_MASK != 0 {
            out.push(b'-'); // -0.0, Issue #289
        }
        out.extend_from_slice(b"0.0");
        return;
    }
    if value < 0.0 {
        out.push(b'-');
        value = -value;
    }
    let mut buffer = [0u8; 25];
    let mut length = 0usize;
    let mut k = 0i32;
    grisu2(value, &mut buffer, &mut length, &mut k);
    prettify(&buffer, length as i32, k, MAX_DECIMAL_PLACES, out);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fmt(d: f64) -> String {
        let mut out = Vec::new();
        dtoa(d, &mut out);
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn formats_like_rapidjson() {
        // Expected values from rapidjson's own writer tests
        assert_eq!(fmt(0.0), "0.0");
        assert_eq!(fmt(-0.0), "-0.0");
        assert_eq!(fmt(1.0), "1.0");
        assert_eq!(fmt(-1.0), "-1.0");
        assert_eq!(fmt(1.2345), "1.2345");
        assert_eq!(fmt(1.2345678), "1.2345678");
        assert_eq!(fmt(0.123456789012), "0.123456789012");
        assert_eq!(fmt(1234567.8), "1234567.8");
        assert_eq!(fmt(-79.39773355813419), "-79.39773355813419");
        assert_eq!(fmt(0.000001), "0.000001");
        assert_eq!(fmt(0.0000001), "1e-7");
        assert_eq!(fmt(1e30), "1e30");
        assert_eq!(fmt(1.234567890123456e30), "1.234567890123456e30");
        assert_eq!(fmt(5e-324), "5e-324");
        assert_eq!(fmt(2.225073858507201e-308), "2.225073858507201e-308");
        assert_eq!(fmt(2.2250738585072014e-308), "2.2250738585072014e-308");
        assert_eq!(fmt(1.7976931348623157e308), "1.7976931348623157e308");
        assert_eq!(fmt(1e21), "1e21");
        assert_eq!(fmt(1e20), "100000000000000000000.0");
    }
}
