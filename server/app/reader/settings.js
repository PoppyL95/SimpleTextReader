import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, '.reader-data'));
for (const publicTree of ['client/app', 'client/css', 'client/fonts', 'client/images', 'shared/core', 'shared/config', 'shared/utils', 'shared/adapters']) {
    const publicRoot = path.join(ROOT, publicTree);
    if (DATA_DIR === publicRoot || DATA_DIR.startsWith(publicRoot + path.sep)) throw new Error('DATA_DIR must be outside public resource trees');
}
export const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');
if (BASE_PATH && !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(BASE_PATH)) {
    throw new Error('BASE_PATH must be an absolute path such as /reader');
}
export const PORT = Number(process.env.PORT || 18140);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Invalid PORT');
export const TRUSTED_PROXY = process.env.TRUSTED_PROXY || '127.0.0.1';
export const MAX_BOOK_BYTES = 50 * 1024 * 1024;
