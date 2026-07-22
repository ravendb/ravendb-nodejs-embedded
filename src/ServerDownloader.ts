import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { EmbeddedServerError, ServerDownloadError } from "./Errors";
import { noopLogger } from "./Logger";
import type { Logger } from "./Logger";
import type { ServerOptions } from "./ServerOptions";

const CACHE_DIR_NAME = "ravendb-embedded";
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_POLL_MS = 500;
const LOCK_WAIT_TIMEOUT_MS = 15 * 60 * 1000;

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
    /** RavenDB version to download, e.g. "7.2.4", or "latest" (default). */
    version?: string;
    /** Overrides the default per-user cache root. */
    cacheDirectory?: string;
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
        const log = options.logger ?? noopLogger;
        const serverPlatform = this.resolvePlatform();
        const cacheRoot = this.getCacheRoot(options.cacheDirectory);
        fs.mkdirSync(cacheRoot, { recursive: true });

        let version = options.version?.trim()
            || process.env["RAVENDB_EMBEDDED_SERVER_VERSION"]?.trim()
            || "latest";
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

        await this._withLock(installDir, async () => {
            if (this.hasServerBinaries(installDir)) {
                return; // another process finished the download while we waited for the lock
            }

            const archiveFile = `${installDir}.download-${process.pid}.${serverPlatform.ext}`;
            const extractDir = `${installDir}.tmp-${process.pid}`;
            try {
                log.info(`Downloading RavenDB server ${version} (${serverPlatform.platform}) from ${downloadUrl} to ${installDir}`);
                await this.downloadArchive(downloadUrl, archiveFile);
                fs.rmSync(extractDir, { recursive: true, force: true });
                fs.mkdirSync(extractDir, { recursive: true });
                await this.extractArchive(archiveFile, extractDir, serverPlatform.ext);
                this._makeExecutable(extractDir);
                fs.renameSync(extractDir, installDir);
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

    /** @internal exposed as a public static only so tests can stub the network. */
    public static async downloadArchive(url: string, destinationFile: string): Promise<void> {
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
        try {
            await pipeline(
                Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
                fs.createWriteStream(destinationFile));
        } catch (error: unknown) {
            fs.rmSync(destinationFile, { force: true });
            throw new ServerDownloadError(
                `Failed to save the RavenDB server archive: ${(error as Error)?.message ?? error}`, url, error);
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
            || "latest";
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
    private static async _withLock(installDir: string, action: () => Promise<void>): Promise<void> {
        const lockDir = `${installDir}.lock`;
        const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

        for (;;) {
            try {
                fs.mkdirSync(lockDir);
                break;
            } catch (error: unknown) {
                if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
                    throw error;
                }
                try {
                    const age = Date.now() - fs.statSync(lockDir).mtimeMs;
                    if (age > LOCK_STALE_MS) {
                        fs.rmSync(lockDir, { recursive: true, force: true });
                        continue;
                    }
                } catch {
                    continue; // lock released between the mkdir attempt and the stat
                }
                if (Date.now() > deadline) {
                    throw new ServerDownloadError(
                        `Timed out waiting for another process to finish downloading the RavenDB server (lock: ${lockDir})`);
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
}
