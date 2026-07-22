import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ServerDownloader } from "../../src/ServerDownloader";
import { ServerOptions } from "../../src/ServerOptions";
import { EmbeddedServerError } from "../../src/Errors";

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
            ServerDownloader.downloadServer({ version: "9.9.9", cacheDirectory: cacheDir }),
            ServerDownloader.downloadServer({ version: "9.9.9", cacheDirectory: cacheDir })
        ]);

        expect(first).toBe(second);
        expect(downloadSpy).toHaveBeenCalledTimes(1);
        expect(extractSpy).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(path.join(first, "Server", "Raven.Server.dll"))).toBe(true);
    });

    it("honors RAVENDB_EMBEDDED_SERVER_VERSION", async () => {
        vi.stubEnv("RAVENDB_EMBEDDED_SERVER_VERSION", "8.8.8");
        const installDir = path.join(cacheDir, `8.8.8-${currentPlatform.platform}`);
        installFakeServer(installDir);
        vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network must not be hit"); }));

        expect(await ServerDownloader.downloadServer({ cacheDirectory: cacheDir })).toBe(installDir);
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
