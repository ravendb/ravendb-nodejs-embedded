export class EmbeddedServerError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "EmbeddedServerError";
    }
}

export class ServerStartupError extends EmbeddedServerError {
    public readonly stdout: string;
    public readonly stderr: string;

    public constructor(message: string, stdout = "", stderr = "") {
        super(message);
        this.name = "ServerStartupError";
        this.stdout = stdout;
        this.stderr = stderr;
    }
}

export class ServerStartupTimeoutError extends ServerStartupError {
    public constructor(message: string, stdout = "", stderr = "") {
        super(message, stdout, stderr);
        this.name = "ServerStartupTimeoutError";
    }
}

export class ServerDownloadError extends EmbeddedServerError {
    public readonly url?: string;

    public constructor(message: string, url?: string, cause?: unknown) {
        super(url ? `${message} (url: ${url})` : message);
        this.name = "ServerDownloadError";
        this.url = url;
        if (cause !== undefined) {
            (this as { cause?: unknown }).cause = cause;
        }
    }
}
