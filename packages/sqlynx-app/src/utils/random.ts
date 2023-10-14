export function generateRandomString(n: number): string {
    let tag = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const charactersLength = characters.length;
    for (let i = 0; i < n; i++) {
        tag += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return tag;
}

export function generateRandomHexString(n: number): string {
    let tag = '';
    const characters = 'abcdef0123456789';
    const charactersLength = characters.length;
    for (let i = 0; i < n; i++) {
        tag += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return tag;
}
