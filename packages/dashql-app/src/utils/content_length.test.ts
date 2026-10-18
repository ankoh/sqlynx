import { describe, expect, it } from 'vitest';

import { decodedContentLength } from './content_length.js';

const response = (headers: Record<string, string>) => new Response('', { headers });

describe('decodedContentLength', () => {
    it('uses Content-Length of plain responses', () => {
        expect(decodedContentLength(response({ 'content-length': '1234' }))).toBe(1234);
    });

    it('does not know the decoded size of encoded responses', () => {
        expect(decodedContentLength(response({ 'content-length': '1234', 'content-encoding': 'br' }))).toBe(0);
        expect(decodedContentLength(response({ 'content-length': '1234', 'content-encoding': 'gzip' }))).toBe(0);
    });

    it('treats identity as plain', () => {
        expect(decodedContentLength(response({ 'content-length': '99', 'content-encoding': 'identity' }))).toBe(99);
    });

    it('returns 0 without a usable Content-Length', () => {
        expect(decodedContentLength(response({}))).toBe(0);
        expect(decodedContentLength(response({ 'content-length': 'nope' }))).toBe(0);
    });
});
