import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ServerOptions } from "../../src/ServerOptions";
import { RavenServerRunner } from "../../src/RavenServerRunner";

const exeName = process.platform === "win32" ? "Raven.Server.exe" : "Raven.Server";

function makeOptions(tempDir: string): ServerOptions {
    const options = new ServerOptions();
    options.serverDirectory = path.join(tempDir, "server");
    options.dataDirectory = path.join(tempDir, "data");
    options.logsPath = path.join(tempDir, "logs");
    options.frameworkVersion = null; // skip `dotnet --info` in unit tests
    fs.mkdirSync(options.serverDirectory, { recursive: true });
    return options;
}

describe("RavenServerRunner.buildCommandLineArgs", () => {
    let tempDir: string;
    beforeEach(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravendb-runner-")); });
    afterEach(() => { fs.rmSync(tempDir, { recursive: true, force: true }); });

    it("builds the default argument set and defaults serverUrl to http", () => {
        const options = makeOptions(tempDir);
        const args = RavenServerRunner.buildCommandLineArgs(options);

        expect(args).toContain(`--Embedded.ParentProcessId=${process.pid}`);
        expect(args).toContain("--Setup.Mode=None");
        expect(args).toContain(`--DataDir=${options.dataDirectory}`);
        expect(args).toContain(`--Logs.Path=${options.logsPath}`);
        expect(args).toContain("--ServerUrl=http://127.0.0.1:0");
        expect(args).toContain("--License.Eula.Accepted=false");
        expect(args).toContain("--License.DisableLicenseSupportCheck=true");
        expect(options.serverUrl).toBe("http://127.0.0.1:0");
    });

    it("puts user commandLineArgs first", () => {
        const options = makeOptions(tempDir);
        options.commandLineArgs = ["--Custom=1"];
        const args = RavenServerRunner.buildCommandLineArgs(options);
        expect(args[0]).toBe("--Custom=1");
    });

    it("throws when both license and licensePath are set", () => {
        const options = makeOptions(tempDir);
        options.licensing.license = "{...}";
        options.licensing.licensePath = "license.json";
        expect(() => RavenServerRunner.buildCommandLineArgs(options)).toThrow(/Only one of/);
    });

    it("emits security args and defaults serverUrl to https when secured", () => {
        const options = makeOptions(tempDir);
        const certPath = path.join(tempDir, "cert.pfx");
        fs.writeFileSync(certPath, Buffer.from([0x30]));
        options.secured(certPath, "secret", "THUMB");

        const args = RavenServerRunner.buildCommandLineArgs(options);
        expect(args).toContain(`--Security.Certificate.Path=${certPath}`);
        expect(args).toContain("--Security.Certificate.Password=secret");
        expect(args).toContain("--Security.WellKnownCertificates.Admin=THUMB");
        expect(args).toContain("--ServerUrl=https://127.0.0.1:0");
        expect(args.some(a => a.startsWith("--Security.Certificate.Load.Exec"))).toBe(false);
    });

    it("emits Load.Exec args for the exec variant and no certificate path/password", () => {
        const options = makeOptions(tempDir);
        const clientCertPath = path.join(tempDir, "client.pfx");
        fs.writeFileSync(clientCertPath, Buffer.from([0x30]));
        options.securedWithExec("vault-cli", "get --cert server", "THUMB", clientCertPath, "secret");

        const args = RavenServerRunner.buildCommandLineArgs(options);
        expect(args).toContain("--Security.Certificate.Load.Exec=vault-cli");
        expect(args).toContain("--Security.Certificate.Load.Exec.Arguments=get --cert server");
        expect(args).toContain("--Security.WellKnownCertificates.Admin=THUMB");
        expect(args).toContain("--ServerUrl=https://127.0.0.1:0");
        expect(args.some(a => a.startsWith("--Security.Certificate.Path"))).toBe(false);
        expect(args.some(a => a.startsWith("--Security.Certificate.Password"))).toBe(false);
    });

    it("omits the Load.Exec.Arguments arg when certExecArgs is empty", () => {
        const options = makeOptions(tempDir);
        const clientCertPath = path.join(tempDir, "client.pfx");
        fs.writeFileSync(clientCertPath, Buffer.from([0x30]));
        options.securedWithExec("vault-cli", "", "THUMB", clientCertPath);

        const args = RavenServerRunner.buildCommandLineArgs(options);
        expect(args).toContain("--Security.Certificate.Load.Exec=vault-cli");
        expect(args.some(a => a.startsWith("--Security.Certificate.Load.Exec.Arguments"))).toBe(false);
    });
});

describe("RavenServerRunner.getExecAndArgs", () => {
    let tempDir: string;
    beforeEach(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ravendb-runner-")); });
    afterEach(() => { fs.rmSync(tempDir, { recursive: true, force: true }); });

    it("prefers the native executable when present", async () => {
        const options = makeOptions(tempDir);
        const exePath = path.join(options.serverDirectory, exeName);
        fs.writeFileSync(exePath, "");
        const { exec, prefixArgs } = await RavenServerRunner.getExecAndArgs(options);
        expect(exec).toBe(exePath);
        expect(prefixArgs).toEqual([]);
    });

    it("falls back to dotnet with Raven.Server.dll", async () => {
        const options = makeOptions(tempDir);
        const dllPath = path.join(options.serverDirectory, "Raven.Server.dll");
        fs.writeFileSync(dllPath, "");
        const { exec, prefixArgs } = await RavenServerRunner.getExecAndArgs(options);
        expect(exec).toBe("dotnet");
        expect(prefixArgs).toEqual([dllPath]);
    });

    it("finds the executable in the Server subdirectory (distribution zip layout)", async () => {
        const options = makeOptions(tempDir);
        const nestedDir = path.join(options.serverDirectory, "Server");
        fs.mkdirSync(nestedDir, { recursive: true });
        const exePath = path.join(nestedDir, exeName);
        fs.writeFileSync(exePath, "");
        const { exec, prefixArgs } = await RavenServerRunner.getExecAndArgs(options);
        expect(exec).toBe(exePath);
        expect(prefixArgs).toEqual([]);
    });

    it("finds Raven.Server.dll in the Server subdirectory", async () => {
        const options = makeOptions(tempDir);
        const nestedDir = path.join(options.serverDirectory, "Server");
        fs.mkdirSync(nestedDir, { recursive: true });
        const dllPath = path.join(nestedDir, "Raven.Server.dll");
        fs.writeFileSync(dllPath, "");
        const { exec, prefixArgs } = await RavenServerRunner.getExecAndArgs(options);
        expect(exec).toBe("dotnet");
        expect(prefixArgs).toEqual([dllPath]);
    });

    it("throws when no server files exist", async () => {
        const options = makeOptions(tempDir);
        await expect(RavenServerRunner.getExecAndArgs(options)).rejects.toThrow(/Server file was not found/);
    });
});
