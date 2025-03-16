import { FileDownloader } from './file_downloader.js';

import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';

export class NativeFileDownloader implements FileDownloader {
    async downloadBufferAsFile(data: Uint8Array, filename: string): Promise<void> {
        const path = await save({
            defaultPath: filename,
            filters: [
                {
                    name: 'DashQL Filter',
                    extensions: ['dashql']
                },
            ],
        });
        if (path != null) {
            await writeFile(path, data);
        }
    }
}


