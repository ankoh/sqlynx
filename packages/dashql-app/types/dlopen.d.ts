declare module 'process' {
    export function dlopen<T = any>(module: any, filename: string, flags?: any): T;
}
