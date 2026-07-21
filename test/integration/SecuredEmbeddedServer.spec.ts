import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EmbeddedServer } from "../../src/EmbeddedServer";
import { ServerOptions } from "../../src/ServerOptions";

const serverDir = path.join(process.cwd(), "RavenDBServer");
const hasServer = ["Raven.Server.exe", "Raven.Server", "Raven.Server.dll"]
    .some(file => fs.existsSync(path.join(serverDir, file))
        || fs.existsSync(path.join(serverDir, "Server", file)));

function hasOpenssl(): boolean {
    try {
        execFileSync("openssl", ["version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

const PFX_PASSWORD = "test-password";

interface Certs {
    pfxPath: string;
    certPemPath: string;
    thumbprint: string;
}

function generateSelfSignedCerts(dir: string): Certs {
    const keyPath = path.join(dir, "key.pem");
    const certPemPath = path.join(dir, "cert.pem");
    const pfxPath = path.join(dir, "cert.pfx");

    execFileSync("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", keyPath, "-out", certPemPath,
        "-days", "1", "-subj", "/CN=127.0.0.1",
        "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
        // RavenDB validates these usages on the server certificate;
        // clientAuth is needed too because the same cert acts as the admin client certificate
        "-addext", "keyUsage=digitalSignature,keyEncipherment",
        "-addext", "extendedKeyUsage=serverAuth,clientAuth"
    ], { stdio: "ignore" });

    execFileSync("openssl", [
        "pkcs12", "-export", "-out", pfxPath,
        "-inkey", keyPath, "-in", certPemPath,
        "-passout", `pass:${PFX_PASSWORD}`
    ], { stdio: "ignore" });

    const thumbprint = new X509Certificate(fs.readFileSync(certPemPath))
        .fingerprint.replace(/:/g, "");

    return { pfxPath, certPemPath, thumbprint };
}

interface User {
    name: string;
}

describe.skipIf(!hasServer || !hasOpenssl())("Secured EmbeddedServer integration", () => {
    const server = new EmbeddedServer();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravendb-embedded-sec-"));

    afterAll(async () => {
        await server.dispose();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("starts a secured server and talks to it over https with a client certificate", async () => {
        const certs = generateSelfSignedCerts(tempDir);

        const options = new ServerOptions();
        options.dataDirectory = path.join(tempDir, "data");
        options.logsPath = path.join(tempDir, "logs");
        options.licensing.eulaAccepted = true;
        options.secured(certs.pfxPath, PFX_PASSWORD, certs.thumbprint, certs.certPemPath);

        await server.startServer(options);

        const url = await server.getServerUri();
        expect(url).toMatch(/^https:\/\/127\.0\.0\.1:\d+/);

        const store = await server.getDocumentStore("secured-it");

        {
            const session = store.openSession();
            await session.store<User>({ name: "secured caveman" }, "users/1");
            await session.saveChanges();
        }
        {
            const session = store.openSession();
            const user = await session.load<User>("users/1");
            expect(user?.name).toBe("secured caveman");
        }

        await server.stopServer();
    }, 300_000);
});
