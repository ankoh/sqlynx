export enum ByteFormat {
    SI = 0,
    IEC = 1,
}

export function formatBytes(value: number, format: ByteFormat = ByteFormat.SI): string {
    const [multiple, k, suffix] = format === ByteFormat.SI ? [1000, 'k', 'B'] : [1024, 'K', 'iB'];
    const exp = (Math.log(value) / Math.log(multiple)) | 0;
    const size = Number((value / Math.pow(multiple, exp)).toFixed(2));
    return `${size} ${exp ? `${k}MGTPEZY`[exp - 1] + suffix : `byte${size !== 1 ? 's' : ''}`}`;
}

export function formatThousands(value: number): string {
    const [multiple, k] = [1000, 'k'];
    const exp = (Math.log(value) / Math.log(multiple)) | 0;
    const size = Number((value / Math.pow(multiple, exp)).toFixed(2));
    return size + (exp ? ` ${`${k}MGTPEZY`[exp - 1]}` : '');
}

export function formatNanoseconds(value: number): string {
    let suffix = 'ns';
    if (value < 1000 * 1000) {
        value /= 1000 * 1000;
        return `${value.toFixed(2)} ms`;
    }
    if (value < 1000 * 1000 * 1000) {
        value /= 1000 * 1000;
        return `${value.toFixed(1)} ms`;
    }
    value /= 1000 * 1000 * 1000;
    return `${value.toFixed(1)} ${suffix}`;
}

export function formatTitle(str: string): string {
    return str.replace(/[-_]/g, ' ').replace(/(?:^\w|[A-Z]|\b\w)/g, (word, index) => word.toUpperCase());
}
