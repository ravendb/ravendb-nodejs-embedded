import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ServerDownloader } from "../../src/ServerDownloader";
import { ServerOptions } from "../../src/ServerOptions";
import { EmbeddedServerError } from "../../src/Errors";
import { noopLogger } from "../../src/Logger";

const currentPlatform = ServerDownloader.resolvePlatform();

describe("ServerDownloader.resolvePlatform", () => {
    it.each([
        ["win32", "x64", "windows-x64", "zip"],
        ["linux", "x64", "linux-x64", "tar.bz2"],
        ["linux", "arm64", "linux-arm64", "tar.bz2"],
        ["darwin", "x64", "macos-x64", "tar.bz2"],
        ["darwin", "arm64", "macos-arm64", "tar.bz2"]
    ])("maps %s/%s to %s (.%s)", (nodePlatform, arch, platform, ext) => {
        expect(ServerDownloader.resolvePlatform(nodePlatform as NodeJS.Platform, arch))
            .toEqual({ platform, ext });
    });

    it.each([
        ["win32", "arm64"],
        ["win32", "ia32"],
        ["freebsd", "x64"],
        ["linux", "riscv64"]
    ])("throws for unsupported %s/%s", (nodePlatform, arch) => {
        expect(() => ServerDownloader.resolvePlatform(nodePlatform as NodeJS.Platform, arch))
            .toThrow(EmbeddedServerError);
    });
});

describe("ServerDownloader.buildDownloadUrl", () => {
    it("builds the direct S3 URL for a pinned version", () => {
        expect(ServerDownloader.buildDownloadUrl("7.2.4", { platform: "linux-x64", ext: "tar.bz2" }))
            .toBe("https://daily-builds.s3.amazonaws.com/RavenDB-7.2.4-linux-x64.tar.bz2");
        expect(ServerDownloader.buildDownloadUrl("7.2.4", { platform: "windows-x64", ext: "zip" }))
            .toBe("https://daily-builds.s3.amazonaws.com/RavenDB-7.2.4-windows-x64.zip");
    });

    it("builds the redirecting latest URL", () => {
        expect(ServerDownloader.buildDownloadUrl("latest", { platform: "linux-x64", ext: "tar.bz2" }))
            .toBe("https://hibernatingrhinos.com/downloads/RavenDB%20for%20Linux%20x64/latest");
        expect(ServerDownloader.buildDownloadUrl("latest", { platform: "macos-arm64", ext: "tar.bz2" }))
            .toBe("https://hibernatingrhinos.com/downloads/RavenDB%20for%20MacOS%20arm64/latest");
    });
});

describe("ServerDownloader.getCacheRoot", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("prefers the explicit override over the env var", () => {
        vi.stubEnv("RAVENDB_EMBEDDED_CACHE_DIR", path.join(os.tmpdir(), "from-env"));
        expect(ServerDownloader.getCacheRoot(path.join(os.tmpdir(), "from-option")))
            .toBe(path.resolve(path.join(os.tmpdir(), "from-option")));
    });

    it("falls back to RAVENDB_EMBEDDED_CACHE_DIR", () => {
        vi.stubEnv("RAVENDB_EMBEDDED_CACHE_DIR", path.join(os.tmpdir(), "from-env"));
        expect(ServerDownloader.getCacheRoot()).toBe(path.resolve(path.join(os.tmpdir(), "from-env")));
    });
});

describe("ServerDownloader.downloadServer", () => {
    let cacheDir: string;

    beforeEach(() => {
        cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravendb-dl-"));
    });

    afterEach(() => {
        fs.rmSync(cacheDir, { recursive: true, force: true });
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    function installFakeServer(installDir: string): void {
        fs.mkdirSync(path.join(installDir, "Server"), { recursive: true });
        fs.writeFileSync(path.join(installDir, "Server", "Raven.Server.dll"), "");
    }

    it("returns the cached install without touching the network", async () => {
        const installDir = path.join(cacheDir, `7.2.4-${currentPlatform.platform}`);
        installFakeServer(installDir);
        vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network must not be hit"); }));

        const result = await ServerDownloader.downloadServer({ version: "7.2.4", cacheDirectory: cacheDir });
        expect(result).toBe(installDir);
        expect(fetch).not.toHaveBeenCalled();
    });

    it("downloads exactly once for concurrent callers", async () => {
        vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network must not be hit"); }));
        const downloadSpy = vi.spyOn(ServerDownloader, "downloadArchive")
            .mockImplementation(async (_url, destinationFile) => {
                await new Promise(r => setTimeout(r, 100));
                fs.writeFileSync(destinationFile, "fake-archive");
            });
        const extractSpy = vi.spyOn(ServerDownloader, "extractArchive")
            .mockImplementation(async (_archive, targetDir) => installFakeServer(targetDir));

        const [first, second] = await Promise.all([
            ServerDownloader.downloadServer({ version: "9.9.9", cacheDirectory: cacheDir, logger: noopLogger }),
            ServerDownloader.downloadServer({ version: "9.9.9", cacheDirectory: cacheDir, logger: noopLogger })
        ]);

        expect(first).toBe(second);
        expect(downloadSpy).toHaveBeenCalledTimes(1);
        expect(extractSpy).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(path.join(first, "Server", "Raven.Server.dll"))).toBe(true);
    });

    it("prints download status to stderr when no logger is provided", async () => {
        vi.spyOn(ServerDownloader, "downloadArchive")
            .mockImplementation(async (_url, destinationFile) => {
                fs.writeFileSync(destinationFile, "fake-archive");
            });
        vi.spyOn(ServerDownloader, "extractArchive")
            .mockImplementation(async (_archive, targetDir) => installFakeServer(targetDir));
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

        await ServerDownloader.downloadServer({ version: "9.9.8", cacheDirectory: cacheDir });

        expect(stderrSpy.mock.calls.some(([line]) =>
            String(line).startsWith("Downloading RavenDB server 9.9.8"))).toBe(true);
        stderrSpy.mockRestore();
    });

    it("honors RAVENDB_EMBEDDED_SERVER_VERSION", async () => {
        vi.stubEnv("RAVENDB_EMBEDDED_SERVER_VERSION", "8.8.8");
        const installDir = path.join(cacheDir, `8.8.8-${currentPlatform.platform}`);
        installFakeServer(installDir);
        vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network must not be hit"); }));

        expect(await ServerDownloader.downloadServer({ cacheDirectory: cacheDir })).toBe(installDir);
    });
});

describe("ServerDownloader.downloadArchive", () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravendb-archive-"));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        vi.unstubAllGlobals();
    });

    function stubFetch(body: string, headers: Record<string, string>): void {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { headers })));
    }

    it("throws and deletes the partial file when the download is truncated", async () => {
        stubFetch("only-14-bytes!", { "content-length": "999" });
        const destination = path.join(tempDir, "archive.zip");

        await expect(ServerDownloader.downloadArchive("https://example.com/a.zip", destination))
            .rejects.toThrow(/truncated: received 14 of 999 bytes/);
        expect(fs.existsSync(destination)).toBe(false);
    });

    it("accepts a download matching Content-Length", async () => {
        stubFetch("exactly-16-bytes", { "content-length": "16" });
        const destination = path.join(tempDir, "archive.zip");

        await ServerDownloader.downloadArchive("https://example.com/a.zip", destination);
        expect(fs.readFileSync(destination, "utf8")).toBe("exactly-16-bytes");
    });

    it("skips the size check when the body was decompressed (content-encoding present)", async () => {
        stubFetch("decompressed-body", { "content-length": "5", "content-encoding": "gzip" });
        const destination = path.join(tempDir, "archive.zip");

        await ServerDownloader.downloadArchive("https://example.com/a.zip", destination);
        expect(fs.existsSync(destination)).toBe(true);
    });

    it("skips the size check when Content-Length is absent", async () => {
        stubFetch("whatever-length", {});
        const destination = path.join(tempDir, "archive.zip");

        await ServerDownloader.downloadArchive("https://example.com/a.zip", destination);
        expect(fs.existsSync(destination)).toBe(true);
    });

    it("reports progress through the logger as deciles of Content-Length", async () => {
        // 4 chunks of 25 bytes against a 100-byte total: 25%, 50%, 75%, 100%
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                for (let i = 0; i < 4; i++) {
                    controller.enqueue(new TextEncoder().encode("x".repeat(25)));
                }
                controller.close();
            }
        });
        vi.stubGlobal("fetch", vi.fn(async () =>
            new Response(stream, { headers: { "content-length": "100" } })));
        const messages: string[] = [];
        const logger = { debug: () => {}, info: (m: string) => messages.push(m), warn: () => {} };

        await ServerDownloader.downloadArchive(
            "https://example.com/a.zip", path.join(tempDir, "archive.zip"), logger);

        // the stream layer may coalesce chunks, so the exact step count is not
        // deterministic — but progress must be reported and end at 100%
        expect(messages.length).toBeGreaterThanOrEqual(1);
        expect(messages.length).toBeLessThanOrEqual(4);
        for (const message of messages) {
            expect(message).toMatch(/^Downloaded 0 MB of 0 MB \(\d+%\)$/);
        }
        expect(messages.at(-1)).toBe("Downloaded 0 MB of 0 MB (100%)");
    });

    it("stays silent without a logger", async () => {
        stubFetch("exactly-16-bytes", { "content-length": "16" });
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

        await ServerDownloader.downloadArchive("https://example.com/a.zip", path.join(tempDir, "archive.zip"));

        expect(stderrSpy).not.toHaveBeenCalled();
        stderrSpy.mockRestore();
    });
});

describe("ServerDownloader.clearCache", () => {
    let cacheDir: string;

    beforeEach(() => {
        cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravendb-clear-"));
    });

    afterEach(() => {
        fs.rmSync(cacheDir, { recursive: true, force: true });
    });

    function makeInstall(name: string): string {
        const dir = path.join(cacheDir, name);
        fs.mkdirSync(path.join(dir, "Server"), { recursive: true });
        fs.writeFileSync(path.join(dir, "Server", "Raven.Server.dll"), "");
        return dir;
    }

    it("returns an empty list for a missing cache directory", () => {
        expect(ServerDownloader.clearCache({ cacheDirectory: path.join(cacheDir, "nope") }))
            .toEqual([]);
    });

    it("removes install dirs, transient artifacts and markers", () => {
        const install = makeInstall("7.2.4-linux-x64");
        const lock = path.join(cacheDir, "7.2.4-linux-x64.lock");
        fs.mkdirSync(lock);
        const partial = path.join(cacheDir, "7.2.5-windows-x64.download-123.zip");
        fs.writeFileSync(partial, "partial");
        const tmp = path.join(cacheDir, "7.2.5-windows-x64.tmp-123");
        fs.mkdirSync(tmp);
        const marker = path.join(cacheDir, "latest-linux-x64.version");
        fs.writeFileSync(marker, "7.2.4");
        const foreign = path.join(cacheDir, "unrelated.txt");
        fs.writeFileSync(foreign, "keep me");

        const removed = ServerDownloader.clearCache({ cacheDirectory: cacheDir });

        expect(removed.sort()).toEqual([install, lock, partial, tmp, marker].sort());
        expect(fs.existsSync(foreign)).toBe(true);
        expect(fs.existsSync(install)).toBe(false);
    });

    it("keeps versions listed in keepVersions along with their markers", () => {
        const kept = makeInstall("7.2.5-linux-x64");
        const dropped = makeInstall("7.2.4-linux-x64");
        const keptMarker = path.join(cacheDir, "latest-linux-x64.version");
        fs.writeFileSync(keptMarker, "7.2.5");
        const droppedMarker = path.join(cacheDir, "latest-windows-x64.version");
        fs.writeFileSync(droppedMarker, "7.2.4");

        const removed = ServerDownloader.clearCache({ cacheDirectory: cacheDir, keepVersions: ["7.2.5"] });

        expect(removed.sort()).toEqual([dropped, droppedMarker].sort());
        expect(fs.existsSync(kept)).toBe(true);
        expect(fs.existsSync(keptMarker)).toBe(true);
    });

    it("still removes transient artifacts of kept versions", () => {
        const kept = makeInstall("7.2.5-linux-x64");
        const staleLock = path.join(cacheDir, "7.2.5-linux-x64.lock");
        fs.mkdirSync(staleLock);

        const removed = ServerDownloader.clearCache({ cacheDirectory: cacheDir, keepVersions: ["7.2.5"] });

        expect(removed).toEqual([staleLock]);
        expect(fs.existsSync(kept)).toBe(true);
    });
});

describe("ServerDownloader.ensureServerBinaries", () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravendb-ensure-"));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    function optionsWithoutBinaries(): ServerOptions {
        // The default serverDirectory (<cwd>/RavenDBServer) may hold a real manual install
        // on a dev machine, so the lookup is stubbed instead of relying on the file system.
        vi.spyOn(ServerDownloader, "hasServerBinaries").mockReturnValue(false);
        const options = new ServerOptions();
        options.licensing.eulaAccepted = true;
        return options;
    }

    it("throws before any network call when the EULA is not accepted", async () => {
        vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network must not be hit"); }));
        const downloadSpy = vi.spyOn(ServerDownloader, "downloadServer");
        const options = optionsWithoutBinaries();
        options.licensing.eulaAccepted = false;

        await expect(ServerDownloader.ensureServerBinaries(options)).rejects.toThrow(/eulaAccepted/);
        expect(downloadSpy).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    it("does not download into an explicitly set serverDirectory", async () => {
        const downloadSpy = vi.spyOn(ServerDownloader, "downloadServer");
        const options = optionsWithoutBinaries();
        options.serverDirectory = path.join(tempDir, "my-own-server");

        await ServerDownloader.ensureServerBinaries(options);
        expect(downloadSpy).not.toHaveBeenCalled();
        expect(options.serverDirectory).toBe(path.join(tempDir, "my-own-server"));
    });

    it("does not download when downloadServer is disabled", async () => {
        const downloadSpy = vi.spyOn(ServerDownloader, "downloadServer");
        const options = optionsWithoutBinaries();
        options.downloadServer = false;

        await ServerDownloader.ensureServerBinaries(options);
        expect(downloadSpy).not.toHaveBeenCalled();
    });

    it("does not download when RAVENDB_EMBEDDED_SKIP_DOWNLOAD=1", async () => {
        vi.stubEnv("RAVENDB_EMBEDDED_SKIP_DOWNLOAD", "1");
        const downloadSpy = vi.spyOn(ServerDownloader, "downloadServer");
        const options = optionsWithoutBinaries();

        await ServerDownloader.ensureServerBinaries(options);
        expect(downloadSpy).not.toHaveBeenCalled();
    });

    it("downloads into the cache and repoints serverDirectory", async () => {
        const downloaded = path.join(tempDir, "cache", "7.2.4-x");
        const downloadSpy = vi.spyOn(ServerDownloader, "downloadServer").mockResolvedValue(downloaded);
        const options = optionsWithoutBinaries();
        options.serverVersion = "7.2.4";
        options.downloadCacheDirectory = path.join(tempDir, "cache");

        await ServerDownloader.ensureServerBinaries(options);
        expect(downloadSpy).toHaveBeenCalledWith({
            version: "7.2.4",
            cacheDirectory: path.join(tempDir, "cache"),
            logger: undefined
        });
        expect(options.serverDirectory).toBe(downloaded);
    });

    it("leaves everything untouched when binaries are already present", async () => {
        const downloadSpy = vi.spyOn(ServerDownloader, "downloadServer");
        const options = new ServerOptions();
        options.serverDirectory = path.join(tempDir, "manual");
        fs.mkdirSync(options.serverDirectory, { recursive: true });
        fs.writeFileSync(path.join(options.serverDirectory, "Raven.Server.dll"), "");

        await ServerDownloader.ensureServerBinaries(options);
        expect(downloadSpy).not.toHaveBeenCalled();
        expect(options.serverDirectory).toBe(path.join(tempDir, "manual"));
    });
});
