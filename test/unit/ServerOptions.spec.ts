import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ServerOptions } from "../../src/ServerOptions";

describe("ServerOptions defaults", () => {
    it("mirrors the C# defaults", () => {
        const options = new ServerOptions();
        expect(options.frameworkVersion).toBe("10.0.9+");
        expect(options.dataDirectory).toBe(path.join(process.cwd(), "RavenDB"));
        expect(options.logsPath).toBe(path.join(process.cwd(), "RavenDB", "Logs"));
        expect(options.serverDirectory).toBe(path.join(process.cwd(), "RavenDBServer"));
        expect(options.dotNetPath).toBe("dotnet");
        expect(options.serverUrl).toBeUndefined();
        expect(options.gracefulShutdownTimeout).toBe(30_000);
        expect(options.processKillTimeout).toBe(5_000);
        expect(options.maxServerStartupTimeDuration).toBe(60_000);
        expect(options.commandLineArgs).toEqual([]);
        expect(options.security).toBeUndefined();
        expect(options.licensing.disableLicenseSupportCheck).toBe(true);
        expect(options.licensing.eulaAccepted).toBe(false);
    });
});

describe("ServerOptions.secured", () => {
    it("throws when the certificate file does not exist", () => {
        const options = new ServerOptions();
        expect(() => options.secured(path.join(os.tmpdir(), "does-not-exist.pem"))).toThrow();
    });

    it("throws for a PFX certificate without an explicit thumbprint", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ravendb-embedded-"));
        const pfxPath = path.join(dir, "cert.pfx");
        fs.writeFileSync(pfxPath, Buffer.from([0x30, 0x82, 0x01, 0x00])); // binary, not PEM
        const options = new ServerOptions();
        expect(() => options.secured(pfxPath, "pass")).toThrow(/serverCertThumbprint/);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("accepts a PFX certificate with an explicit thumbprint and sets security", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ravendb-embedded-"));
        const pfxPath = path.join(dir, "cert.pfx");
        fs.writeFileSync(pfxPath, Buffer.from([0x30, 0x82, 0x01, 0x00]));
        const options = new ServerOptions();
        options.secured(pfxPath, "pass", "AB01CD");
        expect(options.security).toBeDefined();
        expect(options.security!.certificatePath).toBe(pfxPath);
        expect(options.security!.certificatePassword).toBe("pass");
        expect(options.security!.clientCertificateType).toBe("pfx");
        expect(options.security!.serverCertificateThumbprint).toBe("AB01CD");
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("throws when secured() is called twice", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ravendb-embedded-"));
        const pfxPath = path.join(dir, "cert.pfx");
        fs.writeFileSync(pfxPath, Buffer.from([0x30]));
        const options = new ServerOptions().secured(pfxPath, undefined, "AB");
        expect(() => options.secured(pfxPath, undefined, "AB")).toThrow(/already been setup/);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("reads the CA bundle when caCertificatePath is provided", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ravendb-embedded-"));
        const pfxPath = path.join(dir, "cert.pfx");
        const caPath = path.join(dir, "ca.pem");
        fs.writeFileSync(pfxPath, Buffer.from([0x30]));
        fs.writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n");
        const options = new ServerOptions().secured(pfxPath, "pass", "AB", caPath);
        expect(options.security!.ca).toEqual(fs.readFileSync(caPath));
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
