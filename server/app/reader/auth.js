import { timingSafeEqual, randomBytes } from 'node:crypto';

export function authenticate(req, res, next) {
    const authorization = req.get('Authorization');
    if (authorization !== undefined) {
        const match = /^Bearer ([^\s]+)$/i.exec(authorization);
        const expected = process.env.HALS_TOKEN;
        const supplied = Buffer.from(match?.[1] || '');
        const target = Buffer.from(expected || '');
        if (!match || !expected || supplied.length !== target.length || !timingSafeEqual(supplied, target)) {
            return res.status(401).json({ error: 'Invalid companion credentials' });
        }
        req.readerIdentity = { author: 'hals' };
        return next();
    }
    req.readerIdentity = { author: 'reader', user: req.app.get('trust proxy fn')(req.socket.remoteAddress, 0)
        ? (req.get('X-Reader-User') || 'reader') : 'reader' };
    req.session.csrf ??= randomBytes(32).toString('hex');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const expectedOrigin = `${req.protocol}://${req.get('host')}`;
        const origin = req.get('Origin');
        const referer = req.get('Referer');
        let source;
        try { source = origin || (referer ? new URL(referer).origin : undefined); } catch { /* rejected below */ }
        const csrf = req.get('X-CSRF-Token');
        if (source ? source !== expectedOrigin : !csrf || csrf !== req.session.csrf) {
            return res.status(403).json({ error: 'Same-origin request or CSRF token required' });
        }
    }
    next();
}
