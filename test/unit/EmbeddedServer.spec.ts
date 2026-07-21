import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EmbeddedServer, waitForServerUrl } from "../../src/EmbeddedServer";
import { ServerOptions } from "../../src/ServerOptions";
import { ServerStartupError, ServerStartupTimeoutError } from "../../src/Errors";
import { waitForExit } from "../../src/utils/waitForExit";

function fakeProcess(script: string) {
    return spawn(process.execPath, ["-e", script]);
}

describe("waitForServerUrl", () => {
    it("resolves the URL from the marker line", async () => {
        const child = fakeProcess(
            "console.log('starting...'); console.log('Server available on: http://127.0.0.1:1234')");
        const url = await waitForServerUrl(child, new ServerOptions());
        expect(url).toBe("http://127.0.0.1:1234");
        child.kill("SIGKILL");
    });

    it("rejects with stderr content when the process dies without the marker", async () => {
        const child = fakeProcess("console.error('fatal config error'); process.exit(1)");
        await expect(waitForServerUrl(child, new ServerOptions()))
            .rejects.toSatisfy((e: unknown) =>
                e instanceof ServerStartupError
                && !(e instanceof ServerStartupTimeoutError)
                && e.stderr.includes("fatal config error"));
    }, 20_000); // includes the 5 s stdout grace period

    it("rejects with a timeout error when the marker never appears", async () => {
        const child = fakeProcess("setTimeout(() => {}, 60000)");
        const options = new ServerOptions();
        options.maxServerStartupTimeDuration = 500;
        await expect(waitForServerUrl(child, options)).rejects.toBeInstanceOf(ServerStartupTimeoutError);
        child.kill("SIGKILL");
    });
});

describe("EmbeddedServer guards", () => {
    it("getServerUri rejects before startServer", async () => {
        await expect(new EmbeddedServer().getServerUri())
            .rejects.toThrow(/run startServer\(\) before/);
    });

    it("stopServer rejects before startServer", async () => {
        await expect(new EmbeddedServer().stopServer())
            .rejects.toThrow(/before calling startServer/);
    });

    it("restartServer rejects before startServer", async () => {
        await expect(new EmbeddedServer().restartServer())
            .rejects.toThrow(/before calling startServer/);
    });

    it("getDocumentStore rejects before startServer", async () => {
        await expect(new EmbeddedServer().getDocumentStore("db"))
            .rejects.toThrow(/before the server was started/);
    });

    it("getDocumentStore rejects an empty database name", async () => {
        await expect(new EmbeddedServer().getDocumentStore("  "))
            .rejects.toThrow(/database name is mandatory/);
    });

    it("startServer rejects when the server directory has no binaries", async () => {
        const server = new EmbeddedServer();
        const options = new ServerOptions();
        options.serverDirectory = "Z:\\definitely\\not\\here";
        await expect(server.startServer(options)).rejects.toThrow(/Server file was not found/);
        await server.dispose();
    });

    it("second startServer call rejects", async () => {
        const server = new EmbeddedServer();
        const options = new ServerOptions();
        options.serverDirectory = "Z:\\definitely\\not\\here";
        await server.startServer(options).catch(() => {});
        await expect(server.startServer(options)).rejects.toThrow(/already started/);
        await server.dispose();
    });
});

describe("shutdown", () => {
    it("gracefully stops a server that honors the shutdown command", async () => {
        const child = fakeProcess(
            "process.stdin.on('data', d => { if (String(d).includes('shutdown no-confirmation')) process.exit(0); });" +
            "console.log('Server available on: http://127.0.0.1:4321');" +
            "setTimeout(() => {}, 60000)");
        const url = await waitForServerUrl(child, new ServerOptions());
        expect(url).toBe("http://127.0.0.1:4321");
        child.stdin!.write("shutdown no-confirmation\n");
        child.stdin!.end();
        await expect(waitForExit(child, 10_000)).resolves.toBe(true);
    });

    it("writing to stdin of a dead process does not crash when an error listener is attached", async () => {
        const child = fakeProcess("process.exit(0)");
        child.stdin!.on("error", () => {});
        await waitForExit(child, 10_000);
        child.stdin!.write("shutdown no-confirmation\n");
        child.stdin!.end();
        await new Promise(resolve => setTimeout(resolve, 100)); // let any async error surface
        expect(true).toBe(true);
    });
});

describe("logging", () => {
    it("logs server lifecycle through the injected logger", async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravendb-embedded-log-"));
        const fakeServerDir = path.join(tempDir, "server");
        fs.mkdirSync(fakeServerDir, { recursive: true });
        // node executes any file path as JS, so a scripted "Raven.Server.dll" launched
        // via dotNetPath=node acts as a full fake server honoring the shutdown command
        fs.writeFileSync(path.join(fakeServerDir, "Raven.Server.dll"),
            "console.log('Server available on: http://127.0.0.1:9999');" +
            "process.stdin.on('data', d => { if (String(d).includes('shutdown')) process.exit(0); });" +
            "setInterval(() => {}, 1000);");

        const entries: string[] = [];
        const logger = {
            debug: (m: string) => entries.push(`debug:${m}`),
            info: (m: string) => entries.push(`info:${m}`),
            warn: (m: string) => entries.push(`warn:${m}`)
        };

        const server = new EmbeddedServer();
        const options = new ServerOptions();
        options.serverDirectory = fakeServerDir;
        options.dataDirectory = path.join(tempDir, "data");
        options.logsPath = path.join(tempDir, "logs");
        options.dotNetPath = process.execPath;
        options.frameworkVersion = null;
        options.logger = logger;

        try {
            await server.startServer(options);
            expect(await server.getServerUri()).toBe("http://127.0.0.1:9999");
            await server.stopServer();
        } finally {
            await server.dispose();
            fs.rmSync(tempDir, { recursive: true, force: true });
        }

        expect(entries.some(e => e.startsWith("debug:Starting global server:"))).toBe(true);
        expect(entries.some(e => e.startsWith("debug:Try shutdown server PID"))).toBe(true);
        expect(entries.some(e => e.startsWith("warn:"))).toBe(false);
    });
});
