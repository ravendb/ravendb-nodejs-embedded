import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { EmbeddedServerError, ServerDownloadError } from "./Errors";
import { noopLogger } from "./Logger";
import type { Logger } from "./Logger";
import { DEFAULT_SERVER_VERSION } from "./ServerOptions";
import type { ServerOptions } from "./ServerOptions";

const CACHE_DIR_NAME = "ravendb-embedded";
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_POLL_MS = 500;
const LOCK_WAIT_TIMEOUT_MS = 15 * 60 * 1000;
const PROGRESS_STEP_BYTES = 50 * 1024 * 1024; // progress cadence when the total size is unknown

// The distribution is ~350 MB, so a first run with the default (silent) logger would
// otherwise hang for minutes with no output at all. Download progress therefore goes
// to stderr unless the caller injects a logger — pass noopLogger to silence it.
/** @internal exported only so tests can exercise the default progress output. */
export const downloadProgressLogger: Logger = {
    debug: () => {},
    info: message => process.stderr.write(`${message}\n`),
    warn: (message, error) => process.stderr.write(`${message}${error ? ` ${String(error)}` : ""}\n`)
};

function formatMebibytes(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

interface ProgressReporter {
    report(receivedBytes: number): void;
    finish(): void;
}

// An in-place progress bar is only drawn for the default stderr logger on a TTY;
// custom loggers and non-interactive outputs (CI logs, pipes) get discrete
// log lines instead, so their output stays append-only.
function createProgressReporter(log: Logger, expectedBytes: number): ProgressReporter {
    if (log === downloadProgressLogger && process.stderr.isTTY) {
        const barWidth = 20;
        const startedAt = Date.now();
        let lastRendered = -1;
        let dirty = false;
        return {
            report: receivedBytes => {
                // redraw at most once per percent (or per MiB when the total is unknown)
                const step = expectedBytes > 0
                    ? Math.floor((receivedBytes / expectedBytes) * 100)
                    : Math.floor(receivedBytes / (1024 * 1024));
                if (step === lastRendered) {
                    return;
                }
                lastRendered = step;
                dirty = true;
                let line: string;
                if (expectedBytes > 0) {
                    // Playwright-style: "183.6 MiB [====================] 100% 0.0s"
                    const percent = Math.min(100, step);
                    const filled = Math.floor((percent / 100) * barWidth);
                    const bar = "=".repeat(filled) + " ".repeat(barWidth - filled);
                    const elapsedSeconds = (Date.now() - startedAt) / 1000;
                    const etaSeconds = receivedBytes > 0
                        ? (elapsedSeconds / receivedBytes) * Math.max(0, expectedBytes - receivedBytes)
                        : 0;
                    line = `${formatMebibytes(expectedBytes)} [${bar}] ${percent}% ${etaSeconds.toFixed(1)}s`;
                } else {
                    line = `Downloaded ${formatMebibytes(receivedBytes)}`;
                }
                process.stderr.write(`\r${line}`);
            },
            finish: () => {
                if (dirty) {
                    process.stderr.write("\n");
                    dirty = false;
                }
            }
        };
    }

    // report every 10% when the total is known, every PROGRESS_STEP_BYTES otherwise
    let lastReportedDecile = 0;
    let nextReportBytes = PROGRESS_STEP_BYTES;
    return {
        report: receivedBytes => {
            if (expectedBytes > 0) {
                const decile = Math.floor((receivedBytes / expectedBytes) * 10);
                if (decile > lastReportedDecile) {
                    lastReportedDecile = decile;
                    const percent = Math.floor((receivedBytes / expectedBytes) * 100);
                    log.info(`Downloaded ${formatMebibytes(receivedBytes)} of ${formatMebibytes(expectedBytes)} (${percent}%)`);
                }
            } else if (receivedBytes >= nextReportBytes) {
                nextReportBytes += PROGRESS_STEP_BYTES;
                log.info(`Downloaded ${formatMebibytes(receivedBytes)}`);
            }
        },
        finish: () => {}
    };
}

// Product names used by the hibernatingrhinos.com "latest" redirect endpoint,
// verified against the live endpoints (each 307-redirects to the daily-builds S3 bucket).
const LATEST_PRODUCT_NAMES: Record<string, string> = {
    "windows-x64": "Windows x64",
    "linux-x64": "Linux x64",
    "linux-arm64": "Linux arm64",
    "macos-x64": "MacOS x64",
    "macos-arm64": "MacOS arm64"
};

export interface ServerPlatform {
    platform: string;
    ext: "zip" | "tar.bz2";
}

export interface DownloadServerOptions {
    /**
     * RavenDB version to download, e.g. "7.2.4", or "latest". Defaults to
     * {@link DEFAULT_SERVER_VERSION} — the release this package version was
     * built and tested against.
     */
    version?: string;
    /** Overrides the default per-user cache root. */
    cacheDirectory?: string;
    /**
     * Receives download progress and status messages. When omitted, they are
     * printed to stderr (a ~350 MB download must not look like a hang) —
     * pass {@link noopLogger} for full silence.
     */
    logger?: Logger;
}

export class ServerDownloader {
    public static resolvePlatform(
        platform: NodeJS.Platform = process.platform,
        arch: string = process.arch
    ): ServerPlatform {
        if (platform === "win32" && arch === "x64") {
            return { platform: "windows-x64", ext: "zip" };
        }
        if (platform === "linux" && arch === "x64") {
            return { platform: "linux-x64", ext: "tar.bz2" };
        }
        if (platform === "linux" && arch === "arm64") {
            return { platform: "linux-arm64", ext: "tar.bz2" };
        }
        if (platform === "darwin" && arch === "x64") {
            return { platform: "macos-x64", ext: "tar.bz2" };
        }
        if (platform === "darwin" && arch === "arm64") {
            return { platform: "macos-arm64", ext: "tar.bz2" };
        }
        throw new EmbeddedServerError(
            `There is no RavenDB server distribution for ${platform}/${arch}. ` +
            "Install the server manually and point ServerOptions.serverDirectory at it.");
    }

    public static buildDownloadUrl(version: string, serverPlatform: ServerPlatform): string {
        if (version === "latest") {
            const productName = LATEST_PRODUCT_NAMES[serverPlatform.platform];
            if (!productName) {
                throw new EmbeddedServerError(
                    `No "latest" download endpoint is known for platform ${serverPlatform.platform}`);
            }
            return `https://hibernatingrhinos.com/downloads/RavenDB%20for%20${encodeURIComponent(productName)}/latest`;
        }
        return `https://daily-builds.s3.amazonaws.com/RavenDB-${version}-${serverPlatform.platform}.${serverPlatform.ext}`;
    }

    public static getCacheRoot(override?: string): string {
        const fromEnv = process.env["RAVENDB_EMBEDDED_CACHE_DIR"];
        if (override?.trim()) {
            return path.resolve(override);
        }
        if (fromEnv?.trim()) {
            return path.resolve(fromEnv);
        }
        if (process.platform === "win32") {
            const localAppData = process.env["LOCALAPPDATA"] ?? path.join(os.homedir(), "AppData", "Local");
            return path.join(localAppData, CACHE_DIR_NAME);
        }
        const xdgCacheHome = process.env["XDG_CACHE_HOME"];
        const cacheHome = xdgCacheHome?.trim() ? xdgCacheHome : path.join(os.homedir(), ".cache");
        return path.join(cacheHome, CACHE_DIR_NAME);
    }

    public static hasServerBinaries(directory: string): boolean {
        const executableName = process.platform === "win32" ? "Raven.Server.exe" : "Raven.Server";
        for (const candidate of [directory, path.join(directory, "Server")]) {
            if (fs.existsSync(path.join(candidate, executableName))
                || fs.existsSync(path.join(candidate, "Raven.Server.dll"))) {
                return true;
            }
        }
        return false;
    }

    /**
     * Downloads (or reuses from cache) the RavenDB server distribution for the current
     * platform and returns the directory to use as ServerOptions.serverDirectory.
     */
    public static async downloadServer(options: DownloadServerOptions = {}): Promise<string> {
        const log = options.logger ?? downloadProgressLogger;
        const serverPlatform = this.resolvePlatform();
        const cacheRoot = this.getCacheRoot(options.cacheDirectory);
        fs.mkdirSync(cacheRoot, { recursive: true });

        let version = options.version?.trim()
            || process.env["RAVENDB_EMBEDDED_SERVER_VERSION"]?.trim()
            || DEFAULT_SERVER_VERSION;
        let downloadUrl = this.buildDownloadUrl(version, serverPlatform);

        if (version === "latest") {
            const resolved = await this._resolveLatestVersion(cacheRoot, serverPlatform, log);
            version = resolved.version;
            downloadUrl = resolved.url;
        }

        const installDir = path.join(cacheRoot, `${version}-${serverPlatform.platform}`);
        if (this.hasServerBinaries(installDir)) {
            return installDir;
        }

        await this._withLock(installDir, log, async () => {
            if (this.hasServerBinaries(installDir)) {
                return; // another process finished the download while we waited for the lock
            }

            const archiveFile = `${installDir}.download-${process.pid}.${serverPlatform.ext}`;
            const extractDir = `${installDir}.tmp-${process.pid}`;
            try {
                log.info(`Downloading RavenDB server ${version} (${serverPlatform.platform}) from ${downloadUrl}`);
                await this.downloadArchive(downloadUrl, archiveFile, log);
                fs.rmSync(extractDir, { recursive: true, force: true });
                fs.mkdirSync(extractDir, { recursive: true });
                log.info("Extracting the RavenDB server archive...");
                await this.extractArchive(archiveFile, extractDir, serverPlatform.ext);
                this._makeExecutable(extractDir);
                fs.renameSync(extractDir, installDir);
                // completion is not logged here — callers (the CLI, EmbeddedServer.start)
                // report readiness themselves, and a duplicate line would be printed
            } catch (error: unknown) {
                if (error instanceof ServerDownloadError) {
                    throw error;
                }
                throw new ServerDownloadError(
                    `Failed to download the RavenDB server: ${(error as Error)?.message ?? error}`,
                    downloadUrl,
                    error);
            } finally {
                fs.rmSync(archiveFile, { force: true });
                fs.rmSync(extractDir, { recursive: true, force: true });
            }
        });

        if (!this.hasServerBinaries(installDir)) {
            throw new ServerDownloadError(
                `The downloaded archive did not contain the expected server binaries in ${installDir}`,
                downloadUrl);
        }
        this._writeLatestMarker(cacheRoot, serverPlatform, options, version);
        return installDir;
    }

    /**
     * Startup-flow seam: makes sure options.serverDirectory contains server binaries,
     * downloading them into the cache when allowed. Manual installs always win.
     */
    public static async ensureServerBinaries(options: ServerOptions): Promise<void> {
        if (this.hasServerBinaries(options.serverDirectory)) {
            return;
        }

        // A user-managed serverDirectory is never downloaded into (or silently replaced) —
        // only the default <cwd>/RavenDBServer location opts into auto-download.
        const defaultServerDirectory = path.join(process.cwd(), "RavenDBServer");
        if (path.resolve(options.serverDirectory) !== path.resolve(defaultServerDirectory)) {
            return;
        }

        const skipByEnv = ["1", "true"].includes(
            process.env["RAVENDB_EMBEDDED_SKIP_DOWNLOAD"]?.toLowerCase() ?? "");
        if (!options.downloadServer || skipByEnv) {
            return;
        }

        if (options.licensing?.eulaAccepted !== true) {
            throw new EmbeddedServerError(
                "Cannot automatically download the RavenDB server before the EULA is accepted. " +
                "Set ServerOptions.licensing.eulaAccepted = true after reviewing the license terms " +
                "(https://ravendb.net/legal), or install the server manually into serverDirectory.");
        }

        options.serverDirectory = await this.downloadServer({
            version: options.serverVersion,
            cacheDirectory: options.downloadCacheDirectory,
            logger: options.logger
        });
    }

    /**
     * Removes downloaded server distributions from the cache (Puppeteer-style
     * `browsers clear`). Also sweeps transient artifacts (stale locks, partial
     * downloads, temp extract dirs) and `latest-*` version markers whose pinned
     * version is being removed. Unknown entries are left untouched.
     *
     * Entries that cannot be removed (on Windows typically EPERM, because a
     * Raven.Server process is still running from the cache) do not stop the
     * sweep — the rest is removed and an EmbeddedServerError listing the
     * locked entries is thrown at the end.
     *
     * @returns absolute paths of the removed entries
     */
    public static clearCache(options: { cacheDirectory?: string; keepVersions?: string[] } = {}): string[] {
        const cacheRoot = this.getCacheRoot(options.cacheDirectory);
        if (!fs.existsSync(cacheRoot)) {
            return [];
        }

        const keep = new Set((options.keepVersions ?? []).map(v => v.trim()).filter(Boolean));
        const platforms = Object.keys(LATEST_PRODUCT_NAMES);
        const removed: string[] = [];
        const failed: string[] = [];
        const remove = (fullPath: string) => {
            try {
                this.removeCacheEntry(fullPath);
                removed.push(fullPath);
            } catch (error: unknown) {
                const code = (error as NodeJS.ErrnoException)?.code;
                failed.push(code ? `${fullPath} (${code})` : fullPath);
            }
        };

        for (const entry of fs.readdirSync(cacheRoot)) {
            const fullPath = path.join(cacheRoot, entry);

            const marker = /^latest-(.+)\.version$/.exec(entry);
            if (marker && platforms.includes(marker[1])) {
                let pinned = "";
                try {
                    pinned = fs.readFileSync(fullPath, "utf8").trim();
                } catch {
                    // unreadable marker — treat as stale
                }
                if (!keep.has(pinned)) {
                    remove(fullPath);
                }
                continue;
            }

            // install dirs and their transient artifacts: <version>-<platform>[.lock|.tmp-*|.download-*]
            const install = platforms
                .map(platform => new RegExp(`^(.+)-${platform}(\\.lock|\\.tmp-.+|\\.download-.+)?$`).exec(entry))
                .find(match => match !== null);
            if (!install) {
                continue;
            }
            const [, version, transientSuffix] = install;
            if (transientSuffix || !keep.has(version)) {
                remove(fullPath);
            }
        }

        if (failed.length > 0) {
            throw new EmbeddedServerError(
                `Could not remove ${failed.length === 1 ? "a cache entry" : `${failed.length} cache entries`} ` +
                "because its files are in use. If a RavenDB server is still running from the cache " +
                "(or an antivirus scan is holding the files), stop it and run --clear-cache again:\n" +
                failed.map(entry => `  ${entry}`).join("\n"));
        }

        return removed;
    }

    /** @internal exposed as a public static only so tests can simulate locked files. */
    public static removeCacheEntry(fullPath: string): void {
        // maxRetries smooths over short-lived locks (antivirus scans, Windows search
        // indexer); a running Raven.Server still fails and is reported by clearCache.
        fs.rmSync(fullPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }

    /** @internal exposed as a public static only so tests can stub the network. */
    public static async downloadArchive(url: string, destinationFile: string, logger?: Logger): Promise<void> {
        const log = logger ?? noopLogger;
        let response: Response;
        try {
            response = await fetch(url, { redirect: "follow" });
        } catch (error: unknown) {
            throw new ServerDownloadError(
                `Failed to download the RavenDB server: ${(error as Error)?.message ?? error}`, url, error);
        }
        if (!response.ok || !response.body) {
            throw new ServerDownloadError(
                `Failed to download the RavenDB server: HTTP ${response.status} ${response.statusText}`, url);
        }

        // RavenDB publishes no checksum manifest, so a size check against Content-Length
        // (skipped when fetch already decompressed the body) is the strongest available
        // guard against truncated downloads.
        const contentEncoding = response.headers.get("content-encoding");
        const expectedBytes = contentEncoding ? 0 : Number(response.headers.get("content-length") ?? 0);
        let receivedBytes = 0;
        const progress = createProgressReporter(log, expectedBytes);

        try {
            await pipeline(
                Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
                async function* (source: AsyncIterable<Buffer>) {
                    for await (const chunk of source) {
                        receivedBytes += chunk.length;
                        progress.report(receivedBytes);
                        yield chunk;
                    }
                },
                fs.createWriteStream(destinationFile));
        } catch (error: unknown) {
            fs.rmSync(destinationFile, { force: true });
            throw new ServerDownloadError(
                `Failed to save the RavenDB server archive: ${(error as Error)?.message ?? error}`, url, error);
        } finally {
            progress.finish();
        }

        if (expectedBytes > 0 && receivedBytes !== expectedBytes) {
            fs.rmSync(destinationFile, { force: true });
            throw new ServerDownloadError(
                `The RavenDB server download is truncated: received ${receivedBytes} of ${expectedBytes} bytes`,
                url);
        }
    }

    /** @internal exposed as a public static only so tests can stub extraction. */
    public static async extractArchive(archiveFile: string, targetDir: string, ext: "zip" | "tar.bz2"): Promise<void> {
        // Zero runtime dependencies: system tar handles .tar.bz2 on Linux/macOS, and the
        // bsdtar shipped with Windows 10+ also extracts .zip. On Windows the System32 copy
        // is addressed explicitly — a GNU tar earlier on PATH (e.g. from Git Bash) cannot
        // read zip archives. Paths are passed relative to the archive's directory because
        // GNU tar parses a colon in the -f argument (e.g. C:\...) as a remote "host:file".
        let tarCommand = "tar";
        if (process.platform === "win32") {
            const systemTar = path.join(
                process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe");
            if (fs.existsSync(systemTar)) {
                tarCommand = systemTar;
            }
        }

        const workingDir = path.dirname(archiveFile);
        const tarArgs = [
            ext === "tar.bz2" ? "-xjf" : "-xf",
            path.basename(archiveFile),
            "-C",
            path.relative(workingDir, targetDir) || "."
        ];

        let tarError: unknown;
        try {
            await this._spawnAndWait(tarCommand, tarArgs, workingDir);
            return;
        } catch (error: unknown) {
            tarError = error;
        }

        if (ext === "zip" && process.platform === "win32") {
            try {
                await this._spawnAndWait("powershell", [
                    "-NoProfile", "-NonInteractive", "-Command",
                    `Expand-Archive -LiteralPath '${archiveFile}' -DestinationPath '${targetDir}' -Force`
                ]);
                return;
            } catch (error: unknown) {
                tarError = error;
            }
        }

        if ((tarError as NodeJS.ErrnoException)?.code === "ENOENT") {
            throw new ServerDownloadError(
                "Cannot extract the RavenDB server archive: no system 'tar' was found. " +
                "Install tar, or install the server manually and point ServerOptions.serverDirectory at it.");
        }
        throw new ServerDownloadError(
            `Failed to extract the RavenDB server archive: ${(tarError as Error)?.message ?? tarError}`,
            undefined,
            tarError);
    }

    private static async _resolveLatestVersion(
        cacheRoot: string,
        serverPlatform: ServerPlatform,
        log: Logger
    ): Promise<{ version: string; url: string }> {
        // "latest" is sticky: once resolved and installed, later runs reuse the marker and
        // stay fully offline/deterministic. Delete the marker (or pin serverVersion) to move.
        const markerFile = this._latestMarkerPath(cacheRoot, serverPlatform);
        if (fs.existsSync(markerFile)) {
            const pinned = fs.readFileSync(markerFile, "utf8").trim();
            if (pinned && this.hasServerBinaries(path.join(cacheRoot, `${pinned}-${serverPlatform.platform}`))) {
                return { version: pinned, url: this.buildDownloadUrl(pinned, serverPlatform) };
            }
        }

        const latestUrl = this.buildDownloadUrl("latest", serverPlatform);
        let response: Response;
        try {
            response = await fetch(latestUrl, { method: "HEAD", redirect: "follow" });
        } catch (error: unknown) {
            throw new ServerDownloadError(
                `Failed to resolve the latest RavenDB server version: ${(error as Error)?.message ?? error}`,
                latestUrl,
                error);
        }
        if (!response.ok) {
            throw new ServerDownloadError(
                `Failed to resolve the latest RavenDB server version: HTTP ${response.status} ${response.statusText}`,
                latestUrl);
        }

        // e.g. https://daily-builds.s3.amazonaws.com/RavenDB-7.2.4-linux-x64.tar.bz2
        const match = new RegExp(`RavenDB-(.+)-${serverPlatform.platform}\\.`).exec(response.url);
        if (!match) {
            throw new ServerDownloadError(
                `Could not parse the RavenDB server version from the redirect target: ${response.url}`,
                latestUrl);
        }
        log.debug(`Resolved latest RavenDB server version: ${match[1]}`);
        return { version: match[1], url: response.url };
    }

    private static _latestMarkerPath(cacheRoot: string, serverPlatform: ServerPlatform): string {
        return path.join(cacheRoot, `latest-${serverPlatform.platform}.version`);
    }

    private static _writeLatestMarker(
        cacheRoot: string,
        serverPlatform: ServerPlatform,
        options: DownloadServerOptions,
        version: string
    ): void {
        const requested = options.version?.trim()
            || process.env["RAVENDB_EMBEDDED_SERVER_VERSION"]?.trim()
            || DEFAULT_SERVER_VERSION;
        if (requested === "latest") {
            fs.writeFileSync(this._latestMarkerPath(cacheRoot, serverPlatform), version);
        }
    }

    private static _makeExecutable(extractDir: string): void {
        if (process.platform === "win32") {
            return;
        }
        // zip/tar round-trips may drop the executable bit
        for (const relative of ["run.sh", "Raven.Server", path.join("Server", "Raven.Server"), path.join("Server", "run.sh")]) {
            const file = path.join(extractDir, relative);
            if (fs.existsSync(file)) {
                fs.chmodSync(file, 0o755);
            }
        }
    }

    private static _spawnAndWait(command: string, args: string[], cwd?: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
            const stderrChunks: Buffer[] = [];
            child.stderr?.on("data", chunk => stderrChunks.push(chunk));
            child.once("error", reject);
            child.once("exit", code => {
                if (code === 0) {
                    resolve();
                } else {
                    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
                    reject(new Error(`${command} exited with code ${code}${stderr ? `: ${stderr}` : ""}`));
                }
            });
        });
    }

    // mkdir-based cross-process lock so parallel processes (e.g. vitest workers)
    // never download the same distribution twice.
    private static async _withLock(installDir: string, log: Logger, action: () => Promise<void>): Promise<void> {
        const lockDir = `${installDir}.lock`;
        const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
        let waitingLogged = false;
        let reclaimLogged = false;

        for (;;) {
            try {
                fs.mkdirSync(lockDir);
                break;
            } catch (error: unknown) {
                if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
                    throw error;
                }
                let abandoned = false;
                try {
                    abandoned = this._isLockAbandoned(lockDir);
                } catch {
                    continue; // lock released between the mkdir attempt and the inspection
                }
                if (abandoned) {
                    if (!reclaimLogged) {
                        reclaimLogged = true;
                        log.info(`Removing a download lock left behind by a process that is no longer running (lock: ${lockDir})`);
                    }
                    try {
                        fs.rmSync(lockDir, { recursive: true, force: true });
                        continue;
                    } catch {
                        // removal can fail transiently (e.g. EPERM on Windows while another
                        // process touches the dir) — fall through to the deadline check and
                        // poll instead of spinning
                    }
                }
                if (Date.now() > deadline) {
                    throw new ServerDownloadError(
                        `Timed out waiting for another process to finish downloading the RavenDB server (lock: ${lockDir})`);
                }
                if (!waitingLogged) {
                    waitingLogged = true;
                    log.info(`Waiting for another process to finish downloading the RavenDB server (lock: ${lockDir})...`);
                }
                await new Promise(r => setTimeout(r, LOCK_POLL_MS));
            }
        }

        try {
            fs.writeFileSync(path.join(lockDir, "owner"), `${process.pid} ${new Date().toISOString()}`);
            await action();
        } finally {
            fs.rmSync(lockDir, { recursive: true, force: true });
        }
    }

    // A lock whose owner process is dead (e.g. a download interrupted by Ctrl+C)
    // is reclaimed immediately; the mtime-based staleness check remains as a
    // fallback for the tiny window before the owner file is written and for
    // PID-reuse false positives.
    private static _isLockAbandoned(lockDir: string): boolean {
        let ownerPid = 0;
        try {
            ownerPid = Number.parseInt(fs.readFileSync(path.join(lockDir, "owner"), "utf8"), 10);
        } catch {
            // owner file not written yet — fall through to the age check
        }
        if (ownerPid > 0 && !this._isProcessAlive(ownerPid)) {
            return true;
        }
        return Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS;
    }

    private static _isProcessAlive(pid: number): boolean {
        try {
            process.kill(pid, 0); // signal 0: existence probe only
            return true;
        } catch (error: unknown) {
            // EPERM means the process exists but belongs to another user
            return (error as NodeJS.ErrnoException)?.code === "EPERM";
        }
    }
}
