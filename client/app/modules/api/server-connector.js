/** Keep the upstream reader and bookshelf; the server is authoritative for original files and progress. */
import { readerSync } from './reader-sync.js';
import { bookshelf } from '../features/bookshelf.js';
import { WebSocketClient } from './websocket-client.js';
import { readerAnnotations } from '../features/reader-annotations.js';
import { readerReviews } from '../features/reader-reviews.js';

export async function initServerConnector() {
    try {
        await readerSync.init(bookshelf);
        readerAnnotations.init();
        readerReviews.init();
        if (readerSync.online) WebSocketClient.getInstance();
    } catch {
        readerSync.status('尚未同步：服务器连接失败');
    }
}
