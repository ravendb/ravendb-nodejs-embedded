import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EmbeddedServer } from "../../src/EmbeddedServer";
import { ServerOptions } from "../../src/ServerOptions";
import { ServerDownloader } from "../../src/ServerDownloader";

// Downloads a full server distribution (~350 MB) — opt in explicitly:
//   RAVENDB_EMBEDDED_TEST_DOWNLOAD=1 npm run test:integration
const downloadEnabled = process.env["RAVENDB_EMBEDDED_TEST_DOWNLOAD"] === "1";

describe.skipIf(!downloadEnabled)("ServerDownloader integration", () => {
    const server = new EmbeddedServer();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravendb-dl-it-"));

    afterAll(async () => {
        await server.dispose();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("downloads the server and boots it end to end", async () => {
        const cacheDirectory = path.join(tempDir, "cache");

        const installDir = await ServerDownloader.downloadServer({
            cacheDirectory,
            logger: {
                debug: m => console.log(m),
                info: m => console.log(m),
                warn: (m, e) => console.warn(m, e ?? "")
            }
        });
        expect(ServerDownloader.hasServerBinaries(installDir)).toBe(true);

        // second call is a pure cache hit
        const cachedDir = await ServerDownloader.downloadServer({ cacheDirectory });
        expect(cachedDir).toBe(installDir);

        const options = new ServerOptions();
        options.serverDirectory = installDir;
        options.dataDirectory = path.join(tempDir, "data");
        options.logsPath = path.join(tempDir, "logs");
        options.licensing.eulaAccepted = true;

        await server.startServer(options);
        const url = await server.getServerUri();
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);

        const store = await server.getDocumentStore("downloader-it");
        {
            const session = store.openSession();
            await session.store({ name: "downloaded" }, "users/1");
            await session.saveChanges();
        }
        {
            const session = store.openSession();
            const user = await session.load<{ name: string }>("users/1");
            expect(user?.name).toBe("downloaded");
        }

        await server.stopServer();
    }, 900_000);
});
