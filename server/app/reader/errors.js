export class ReaderError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}
