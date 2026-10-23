import { FileDownloader } from './file_downloader.js';
import { WebFileDownloader } from './web_file_downloader.js';

/// The desktop app downloads files through the browser download handling of Electron
const FILE_DOWNLOADER: FileDownloader = new WebFileDownloader();

export const useFileDownloader = (): FileDownloader => FILE_DOWNLOADER;
