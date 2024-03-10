import { jest } from '@jest/globals';

describe('Global fetch mock', () => {
    it("can be mocked with jest", async () => {
        jest.spyOn(global, 'fetch').mockImplementationOnce(async (): Promise<any> => {
            return {
                ok: true,
                status: 200,
            };
        });
        const response = await fetch("sqlynx-native://foo", { method: 'POST' });
        expect(response.status).toEqual(200);
        (global.fetch as jest.Mock).mockRestore();
    });
});
