import path from 'path';
import fs from 'fs/promises';

const configPath = path.resolve(__dirname, '../static/config.json');

describe('App config', () => {
    it('can be parsed', async () => {
        const file = await fs.readFile(configPath, 'utf-8');
        expect(() => JSON.parse(file)).not.toThrow();
    });
    it('defines HyperApi artifacts', async () => {
        const file = await fs.readFile(configPath, 'utf-8');
        const config = JSON.parse(file);
        expect(config.connectors?.hyper?.hyperApi).toBeDefined();
    });
});
