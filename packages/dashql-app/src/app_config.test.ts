import * as fs from 'fs/promises';
import { fileURLToPath } from 'node:url';

const configPath = new URL('../static/config.json', import.meta.url);

describe('App config', () => {
    it('can be parsed', async () => {
        const file = await fs.readFile(fileURLToPath(configPath), 'utf-8');
        expect(() => JSON.parse(file)).not.toThrow();
    });
});
