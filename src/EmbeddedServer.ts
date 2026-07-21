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

        // stderr closed or process exited — give stdout a grace period to still deliver the URL (mirrors C#)
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

    private get _log(): Logger {
        return this._serverOptions?.logger ?? noopLogger;
    }

    public async startServer(options?: ServerOptions): Promise<void> {
        if (this._serverTask) {
            throw new EmbeddedServerError("The server was already started");
        }

        this._serverOptions = options ?? new ServerOptions();

        const task = this._runServer(this._serverOptions);
        task.catch(() => {}); // error still surfaces via the awaits below / on first use
        this._serverTask = task;

        await task;
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

    private async _runServer(options: ServerOptions): Promise<ServerHandle> {
        const serverProcess = await RavenServerRunner.run(options);

        this._log.debug(`Starting global server: ${serverProcess.pid ?? "<no PID>"}`);

        serverProcess.stdin?.on("error", () => {
            // swallow EPIPE/write-after-end when the server died mid-shutdown
        });

        serverProcess.on("exit", () => this.emit("serverProcessExited"));

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
        // The node client has no on-disk topology cache (C# DisableTopologyCache has no equivalent);
        // this flag pins the client to the single spawned embedded node and avoids pointless topology chatter.
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
