/** Self-hosted reader: gateway-authenticated browser and companion API. */
import express from 'express';
import session from 'express-session';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ROOT, BASE_PATH, PORT, TRUSTED_PROXY } from './reader/settings.js';
import { ReaderStore } from './reader/store.js';
import { readerRouter } from './reader/routes.js';
import { authenticate } from './reader/auth.js';
import { WebSocketServer } from 'ws';

export const app = express();
app.disable('x-powered-by');
app.enable('strict routing');
app.set('trust proxy', TRUSTED_PROXY.split(',').map(value => value.trim()));
app.use(session({ secret: process.env.SESSION_SECRET || randomBytes(32).toString('hex'),
    name: 'readerSession', resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'strict', path: `${BASE_PATH}/`, secure: 'auto' } }));
app.use(express.json({ limit: '64kb' }));
app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob: https://fontsapi.zeoseven.com; connect-src 'self'; object-src 'none'; frame-ancestors 'none'");
    next();
});
const store = await new ReaderStore().init();
app.use(`${BASE_PATH}/api`, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, readerRouter(store));
if (BASE_PATH) app.get(BASE_PATH, (_req, res) => res.redirect(301, `${BASE_PATH}/`));
const manifest = JSON.parse(await readFile(path.join(ROOT, 'client/manifests/PWA/manifest.json'), 'utf8'));
app.get(`${BASE_PATH}/client/manifests/PWA/manifest.json`, (_req, res) => res.json({ ...manifest,
    start_url: `${BASE_PATH}/`, scope: `${BASE_PATH}/`, id: `${BASE_PATH}/`,
    icons: manifest.icons.map(icon => ({ ...icon, src: `${BASE_PATH}/client/images/icon.png` })) }));
// Explicit frontend trees only. No repository-root, server, DATA_DIR or books static mount.
for (const folder of ['app', 'css', 'fonts', 'images']) {
    app.use(`${BASE_PATH}/client/${folder}`, express.static(path.join(ROOT, 'client', folder), { index: false, dotfiles: 'deny' }));
}
for (const folder of ['core', 'config', 'utils', 'adapters']) {
    app.use(`${BASE_PATH}/shared/${folder}`, express.static(path.join(ROOT, 'shared', folder), { index: false, dotfiles: 'deny' }));
}
for (const file of ['index.html', 'version.json', 'help.json']) {
    app.get(`${BASE_PATH}/${file}`, (_req, res) => res.sendFile(path.join(ROOT, file)));
}
app.get(`${BASE_PATH}/`, (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.use((_req, res) => res.status(404).send('Not found'));
app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: 'Invalid request' }));
const server = createServer(app);
const websocket = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
    if (req.url !== `${BASE_PATH}/ws`) { socket.destroy(); return; }
    const origin = req.headers.origin;
    const protocol = app.get('trust proxy fn')(req.socket.remoteAddress, 0) && req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    if (origin && origin !== `${protocol}://${req.headers.host}`) { socket.destroy(); return; }
    // Reuse HTTP identity/CSRF middleware; gateway protects the browser route.
    authenticate(Object.assign(req, { app, session: {}, get: name => req.headers[name.toLowerCase()], protocol }),
        { status: () => ({ json: () => socket.destroy() }) }, () => {
            websocket.handleUpgrade(req, socket, head, ws => websocket.emit('connection', ws, req));
        });
});
server.listen(PORT, '127.0.0.1', () => console.log(`Reader listening on 127.0.0.1:${PORT}${BASE_PATH}/`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    for (const ws of websocket.clients) ws.terminate();
    websocket.close();
    server.close(() => { store.close(); process.exit(0); });
});
