export class ReaderError extends Error {
    constructor(status, message, details = {}) { super(message); this.status = status; Object.assign(this, details); }
}
