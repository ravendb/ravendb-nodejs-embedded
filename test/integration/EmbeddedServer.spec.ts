import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EmbeddedServer } from "../../src/EmbeddedServer";
import { ServerOptions } from "../../src/ServerOptions";

const serverDir = path.join(process.cwd(), "RavenDBServer");
const hasServer = ["Raven.Server.exe", "Raven.Server", "Raven.Server.dll"]
    .some(file => fs.existsSync(path.join(serverDir, file)));

interface User {
    name: string;
}

describe.skipIf(!hasServer)("EmbeddedServer integration", () => {
    const server = new EmbeddedServer();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravendb-embedded-it-"));

    afterAll(async () => {
        await server.dispose();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("starts, stores and loads a document, restarts, stops", async () => {
        const options = new ServerOptions();
        options.dataDirectory = path.join(tempDir, "data");
        options.logsPath = path.join(tempDir, "logs");
        options.licensing.eulaAccepted = true;

        await server.startServer(options);

        const url = await server.getServerUri();
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);

        const pid = await server.getServerProcessId();
        expect(pid).toBeGreaterThan(0);

        const store = await server.getDocumentStore("embedded-it");

        {
            const session = store.openSession();
            await session.store<User>({ name: "caveman" }, "users/1");
            await session.saveChanges();
        }
        {
            const session = store.openSession();
            const user = await session.load<User>("users/1");
            expect(user?.name).toBe("caveman");
        }

        // second call returns the cached store
        const storeAgain = await server.getDocumentStore("embedded-it");
        expect(storeAgain).toBe(store);

        // restart brings the server back up (possibly on a new port)
        await server.restartServer();
        const urlAfterRestart = await server.getServerUri();
        expect(urlAfterRestart).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);

        await server.stopServer();
    }, 300_000);
});
