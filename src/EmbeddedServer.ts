import { EventEmitter } from "node:events";
import * as readline from "node:readline";
import type { ChildProcess } from "node:child_process";
import { CreateDatabaseOperation, DocumentStore } from "ravendb";
import type { IDocumentStore, IStoreAuthOptions } from "ravendb";
import { DatabaseOptions } from "./DatabaseOptions";
import { ServerOptions } from "./ServerOptions";
import { RavenServerRunner } from "./RavenServerRunner";
import { EmbeddedServerError, ServerStartupError, ServerStartupTimeoutError } from "./Errors";
import { openBrowser } from "./utils/openBrowser";
import { hasExited, waitForExit } from "./utils/waitForExit";
import { withAbort } from "./utils/withAbort";
import { noopLogger } from "./Logger";
import type { Logger } from "./Logger";

const SERVER_URL_PREFIX = "Server available on: ";
const STDERR_GRACE_MS = 5_000;

interface ServerHandle {
    url: string;
    serverProcess: ChildProcess;
}

export function waitForServerUrl(serverProcess: ChildProcess, options: ServerOptions): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const stdoutLines: string[] = [];
        const stderrLines: string[] = [];
        let settled = false;
        let graceTimer: NodeJS.Timeout | null = null;

        const finish = (action: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            if (graceTimer) {
                clearTimeout(graceTimer);
            }
            action();
        };

        const buildError = (isTimeout: boolean): ServerStartupError => {
            const stdout = stdoutLines.join("\n");
            const stderr = stderrLines.join("\n");
            let message = isTimeout
                ? `Server failed to start in ${options.maxServerStartupTimeDuration / 1000} s.`
                : "Unable to start the RavenDB Server";
            if (stderr.trim()) {
                message += `\nError:\n${stderr}`;
            }
            if (stdout.trim()) {
                message += `\nOutput:\n${stdout}`;
            }
            return isTimeout
                ? new ServerStartupTimeoutError(message, stdout, stderr)
                : new ServerStartupError(message, stdout, stderr);
        };

        // stderr closed or process exited — give stdout a grace period to still deliver the URL
        const failAfterGrace = () => {
            if (settled || graceTimer) {
                return;
            }
            graceTimer = setTimeout(() => finish(() => reject(buildError(false))), STDERR_GRACE_MS);
        };

        const timeout = setTimeout(
            () => finish(() => reject(buildError(true))),
            options.maxServerStartupTimeDuration);

        if (!serverProcess.stdout || !serverProcess.stderr) {
            finish(() => reject(new ServerStartupError("Server process has no stdio pipes")));
            return;
        }

        readline.createInterface({ input: serverProcess.stdout }).on("line", line => {
            if (settled) {
                return;
            }
            stdoutLines.push(line);
            if (line.startsWith(SERVER_URL_PREFIX)) {
                finish(() => resolve(line.substring(SERVER_URL_PREFIX.length).trim()));
            }
        });

        readline.createInterface({ input: serverProcess.stderr }).on("line", line => {
            if (settled) {
                return;
            }
            stderrLines.push(line);
        });

        serverProcess.stderr.once("close", failAfterGrace);
        serverProcess.once("exit", failAfterGrace);
        serverProcess.once("error", error => finish(() => reject(new ServerStartupError(
            `Unable to execute server: ${error.message}`,
            stdoutLines.join("\n"),
            stderrLines.join("\n")))));
    });
}

export class EmbeddedServer extends EventEmitter {
    private _serverTask: Promise<ServerHandle> | null = null;
    private _serverOptions: ServerOptions | null = null;
    private readonly _documentStores = new Map<string, Promise<IDocumentStore>>();
    private _signalHandlersInstalled = false;

    private readonly _handleSignal = (signal: NodeJS.Signals): void => {
        this._log.debug(`Received ${signal} — shutting down the embedded server.`);
        this.dispose()
            .catch(() => {})
            .finally(() => {
                // dispose() removed this handler; re-deliver the signal only when the
                // app has no handler of its own, so the process still exits with the
                // conventional signal exit code. Apps with their own handlers keep
                // full control over when (and whether) the process dies.
                if (process.listenerCount(signal) === 0) {
                    process.kill(process.pid, signal);
                }
            });
    };

    private readonly _handleBeforeExit = (): void => {
        // beforeExit may run async work — the event loop stays alive until dispose()
        // finishes. dispose() also unregisters this handler, so no beforeExit loop.
        this.dispose().catch(() => {});
    };

    private get _log(): Logger {
        return this._serverOptions?.logger ?? noopLogger;
    }

    public async startServer(options?: ServerOptions, signal?: AbortSignal): Promise<void> {
        if (this._serverTask) {
            throw new EmbeddedServerError("The server was already started");
        }

        // Snapshot the options: startup resolves serverDirectory (auto-download) and
        // serverUrl internally, and the caller's object must not be mutated by that —
        // nor should later caller-side edits leak into a running server.
        this._serverOptions = EmbeddedServer._cloneOptions(options ?? new ServerOptions());

        if (this._serverOptions.installSignalHandlers) {
            this._installSignalHandlers();
        }

        const task = this._runServer(this._serverOptions, signal);
        task.catch(() => {}); // error still surfaces via the awaits below / on first use
        this._serverTask = task;

        try {
            await withAbort(task, signal);
        } catch (error) {
            if (signal?.aborted) {
                // the spawned process may still be booting — tear it down
                this.dispose().catch(() => {});
            }
            throw error;
        }
    }

    private static _cloneOptions(source: ServerOptions): ServerOptions {
        const clone: ServerOptions = Object.assign(Object.create(Object.getPrototypeOf(source)), source);
        clone.commandLineArgs = [...source.commandLineArgs];
        clone.licensing = Object.assign(Object.create(Object.getPrototypeOf(source.licensing)), source.licensing);
        return clone;
    }

    public async restartServer(): Promise<void> {
        const existing = this._serverTask;
        if (!this._serverOptions || !existing) {
            throw new EmbeddedServerError("Cannot call restartServer() before calling startServer()");
        }

        try {
            const { serverProcess } = await existing;
            await this._shutdownServerProcess(serverProcess);
        } catch {
            // process might already be dead or failed to start
        }

        if (this._serverTask !== existing) {
            throw new EmbeddedServerError(
                "The server changed while restarting it. Are you calling restartServer() concurrently?");
        }

        const task = this._runServer(this._serverOptions);
        task.catch(() => {});
        this._serverTask = task;
        await task;
    }

    public async stopServer(signal?: AbortSignal): Promise<void> {
        const existing = this._serverTask;
        if (!this._serverOptions || !existing) {
            throw new EmbeddedServerError("Cannot call stopServer() before calling startServer()");
        }

        const { serverProcess } = await existing;

        const onAbort = () => {
            this._killServerProcess(serverProcess).catch(() => {});
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        try {
            await this._shutdownServerProcess(serverProcess);
        } catch {
            // process might already be dead
        } finally {
            signal?.removeEventListener("abort", onAbort);
        }
    }

    public getDocumentStore(database: string | DatabaseOptions): Promise<IDocumentStore> {
        const options = typeof database === "string" ? new DatabaseOptions(database) : database;
        const databaseName = options.databaseRecord.databaseName;

        if (!databaseName?.trim()) {
            return Promise.reject(new EmbeddedServerError("The database name is mandatory"));
        }
        if (!this._serverOptions) {
            return Promise.reject(new EmbeddedServerError(
                "Cannot get a document store before the server was started"));
        }

        let storePromise = this._documentStores.get(databaseName);
        if (!storePromise) {
            this._log.debug(`Creating document store for '${databaseName}'.`);
            storePromise = this._createDocumentStore(options, databaseName);
            storePromise.catch(() => {});
            this._documentStores.set(databaseName, storePromise);
        }
        return storePromise;
    }

    public async getServerUri(signal?: AbortSignal): Promise<string> {
        const server = this._serverTask;
        if (!server) {
            throw new EmbeddedServerError("Please run startServer() before trying to use the server");
        }
        return (await withAbort(server, signal)).url;
    }

    public async getServerProcessId(signal?: AbortSignal): Promise<number> {
        const server = this._serverTask;
        if (!server) {
            throw new EmbeddedServerError("Please run startServer() before trying to use the server");
        }
        const { serverProcess } = await withAbort(server, signal);
        if (serverProcess.pid === undefined) {
            throw new EmbeddedServerError("Server process has no PID");
        }
        return serverProcess.pid;
    }

    public async openStudioInBrowser(): Promise<void> {
        const serverUrl = await this.getServerUri();
        openBrowser(new URL("studio/index.html?disableAnalytics=true", serverUrl).toString());
    }

    public async dispose(): Promise<void> {
        this._uninstallSignalHandlers();

        const task = this._serverTask;
        this._serverTask = null;
        if (!task) {
            return;
        }

        try {
            const { serverProcess } = await task;
            await this._shutdownServerProcess(serverProcess);
        } catch {
            // startup failed — nothing to shut down
        }

        for (const storePromise of this._documentStores.values()) {
            try {
                (await storePromise).dispose();
            } catch {
                // store may have failed to initialize
            }
        }
        this._documentStores.clear();
    }

    public [Symbol.asyncDispose](): Promise<void> {
        return this.dispose();
    }

    private _installSignalHandlers(): void {
        if (this._signalHandlersInstalled) {
            return;
        }
        this._signalHandlersInstalled = true;
        process.on("SIGINT", this._handleSignal);
        process.on("SIGTERM", this._handleSignal);
        process.on("beforeExit", this._handleBeforeExit);
    }

    private _uninstallSignalHandlers(): void {
        if (!this._signalHandlersInstalled) {
            return;
        }
        this._signalHandlersInstalled = false;
        process.removeListener("SIGINT", this._handleSignal);
        process.removeListener("SIGTERM", this._handleSignal);
        process.removeListener("beforeExit", this._handleBeforeExit);
    }

    private async _runServer(options: ServerOptions, signal?: AbortSignal): Promise<ServerHandle> {
        const serverProcess = await RavenServerRunner.run(options);

        this._log.debug(`Starting global server: ${serverProcess.pid ?? "<no PID>"}`);

        serverProcess.stdin?.on("error", () => {
            // swallow EPIPE/write-after-end when the server died mid-shutdown
        });

        serverProcess.on("exit", () => this.emit("serverProcessExited"));

        // an aborted startup must not leave the spawned process behind, and it must die
        // right away — not after the full startup timeout has elapsed
        if (signal?.aborted) {
            await this._killServerProcess(serverProcess);
            throw signal.reason ?? new Error("The operation was aborted");
        }
        const onAbort = () => {
            this._killServerProcess(serverProcess).catch(() => {});
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        serverProcess.once("exit", () => signal?.removeEventListener("abort", onAbort));

        // Best-effort cleanup when the host process exits. The real safety net is the
        // server-side --Embedded.ParentProcessId watchdog.
        const killOnExit = () => {
            try {
                serverProcess.kill();
            } catch {
                // ignore
            }
        };
        process.once("exit", killOnExit);
        serverProcess.once("exit", () => process.removeListener("exit", killOnExit));

        try {
            const url = await waitForServerUrl(serverProcess, options);
            return { url, serverProcess };
        } catch (error) {
            await this._shutdownServerProcess(serverProcess).catch(() => {});
            throw error;
        }
    }

    private async _createDocumentStore(options: DatabaseOptions, databaseName: string): Promise<IDocumentStore> {
        const serverUrl = await this.getServerUri();

        const security = this._serverOptions!.security;
        const authOptions: IStoreAuthOptions | undefined = security
            ? {
                certificate: security.clientCertificate,
                type: security.clientCertificateType,
                password: security.certificatePassword,
                ca: security.ca
            } as IStoreAuthOptions
            : undefined;

        const store = authOptions
            ? new DocumentStore([serverUrl], databaseName, authOptions)
            : new DocumentStore([serverUrl], databaseName);

        if (options.conventions) {
            store.conventions = options.conventions;
        }
        // The node client has no on-disk topology cache; this flag pins the client to the
        // single spawned embedded node and avoids pointless topology chatter.
        store.conventions.disableTopologyUpdates = true;

        store.once("afterDispose", (callback: () => void) => {
            this._documentStores.delete(databaseName);
            callback();
        });

        store.initialize();

        if (!options.skipCreatingDatabase) {
            await this._tryCreateDatabase(options, store);
        }

        return store;
    }

    private async _tryCreateDatabase(options: DatabaseOptions, store: IDocumentStore): Promise<void> {
        try {
            await store.maintenance.server.send(new CreateDatabaseOperation(options.databaseRecord));
        } catch (error: unknown) {
            if ((error as Error)?.name === "ConcurrencyException") {
                this._log.debug(`${options.databaseRecord.databaseName} already exists.`);
                return;
            }
            throw error;
        }
    }

    private async _shutdownServerProcess(serverProcess: ChildProcess): Promise<void> {
        if (!serverProcess || hasExited(serverProcess)) {
            return;
        }

        const gracefulTimeout = this._serverOptions?.gracefulShutdownTimeout ?? 30_000;
        try {
            this._log.debug(`Try shutdown server PID ${serverProcess.pid} gracefully.`);
            serverProcess.stdin?.write("shutdown no-confirmation\n");
            serverProcess.stdin?.end();

            if (await waitForExit(serverProcess, gracefulTimeout)) {
                return;
            }
            this._log.warn(`Failed to shutdown server PID ${serverProcess.pid} gracefully in ${gracefulTimeout}ms`);
        } catch (error: unknown) {
            this._log.warn(`Failed to shutdown server PID ${serverProcess.pid} gracefully in ${gracefulTimeout}ms`, error);
        }

        await this._killServerProcess(serverProcess);
    }

    private async _killServerProcess(serverProcess: ChildProcess): Promise<void> {
        if (!serverProcess || hasExited(serverProcess)) {
            return;
        }

        const killTimeout = this._serverOptions?.processKillTimeout ?? 5_000;
        try {
            this._log.debug(`Killing global server PID ${serverProcess.pid}.`);
            serverProcess.kill("SIGKILL");
            if (!await waitForExit(serverProcess, killTimeout)) {
                this._log.info(`Process ${serverProcess.pid} did not exit after kill within ${killTimeout}ms.`);
            }
        } catch (error: unknown) {
            // process may have died in the meantime
            this._log.warn(`Failed to kill process ${serverProcess.pid}`, error);
        }
    }
}

export const embeddedServer = new EmbeddedServer();
