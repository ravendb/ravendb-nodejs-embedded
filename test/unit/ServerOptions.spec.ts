import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ServerOptions, DEFAULT_SERVER_VERSION } from "../../src/ServerOptions";

// self-signed throwaway certificate (CN=ravendb-embedded-test, 2026-2036), no key material
const TEST_PEM_CERT = `-----BEGIN CERTIFICATE-----
MIIDITCCAgmgAwIBAgIUQInzqVVxQjspLtKHui7sESZyKJQwDQYJKoZIhvcNAQEL
BQAwIDEeMBwGA1UEAwwVcmF2ZW5kYi1lbWJlZGRlZC10ZXN0MB4XDTI2MDcyMjA1
NDIwOFoXDTM2MDcxOTA1NDIwOFowIDEeMBwGA1UEAwwVcmF2ZW5kYi1lbWJlZGRl
ZC10ZXN0MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArjCmBu1QHqX2
XxGpVVEFS9i2Ty9EikrOpDacx5OQ/N74BR3RGqTczJ/LM2pYC+sY3sMZo7u3uvvm
Exah9bSKrZc/sWJb2YymVe0T4lqq+2DhOMQ3SvGelWZ7+f6MK6ktXlI8aJMbDw9l
osUIsjNBq6vVlAsPCK2WN09V2qc18BXPjBEPpW+aJioEsj/Vc8HWba2QinrvN+iN
KhUS/CHCIs3qtd7HzfXfjRBe410daGn4M5W23Zg2tEhqgaufxP8GWhgFdcCbrlsy
zczCavhF8OhfaZ61yChwsF5z6mGGarh6eWOaoKU38wt5+bzLwxPlmsuGrG/T+FsW
mbUIidmNtwIDAQABo1MwUTAdBgNVHQ4EFgQU+hRqxsYcIRpKy5aj2E+1qlSjXWEw
HwYDVR0jBBgwFoAU+hRqxsYcIRpKy5aj2E+1qlSjXWEwDwYDVR0TAQH/BAUwAwEB
/zANBgkqhkiG9w0BAQsFAAOCAQEACr8hr0fLCJ0c60sLnsuFEe4fLTt4qWMe/mkc
tuIsJ1XTrVYK2U+WxglB6YwDWiKMCX/hccmOQVK+d2xnjdtD+hkMXWu/Ph8xN4kT
c2Wl+QF9H9gvokWBVSVcDCDG9gQfIp4AGFWiikvEo/HpaZQf7ct+TZeozWmGnek4
oYopBeSwsWn+uvdyu7Msd+NPEevV5/qCEkT0uo48hGfhwM26V8MzhlX3uFZt++SO
QV5oEsAZ4CLgtTklGIUKq/m4J8wnVFV0zoGgN6wqN/cR/ngtK5k82J2Df37w+jJ2
otE4a0mRPEhTKOPfVh2LA/y8vOx7Sj1OWvmYAOUzO7lCfXX/jA==
-----END CERTIFICATE-----
`;
const TEST_PEM_THUMBPRINT = "5AC4716B7FDF76C5824054EE5F7A4EFB3039D1DD";

describe("ServerOptions defaults", () => {
    it("has the expected defaults", () => {
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

    it("pins the default server version to the package version", () => {
        const packageJson = JSON.parse(
            fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
        expect(new ServerOptions().serverVersion).toBe(DEFAULT_SERVER_VERSION);
        // package-only fixes may append a prerelease/build suffix (e.g. 7.2.5-1)
        // without retargeting the server release
        expect(packageJson.version === DEFAULT_SERVER_VERSION
            || packageJson.version.startsWith(`${DEFAULT_SERVER_VERSION}-`)).toBe(true);
    });
});

describe("ServerOptions constructor init object", () => {
    it("applies provided fields and keeps defaults for the rest", () => {
        const options = new ServerOptions({
            downloadServer: false,
            dotNetPath: "/usr/local/bin/dotnet",
            logsPath: "/var/log/ravendb"
        });
        expect(options.downloadServer).toBe(false);
        expect(options.dotNetPath).toBe("/usr/local/bin/dotnet");
        expect(options.logsPath).toBe("/var/log/ravendb");
        // untouched fields keep their defaults
        expect(options.serverVersion).toBe(DEFAULT_SERVER_VERSION);
        expect(options.dataDirectory).toBe(path.join(process.cwd(), "RavenDB"));
        expect(options.gracefulShutdownTimeout).toBe(30_000);
    });

    it("merges licensing as a partial into LicensingOptions", () => {
        const options = new ServerOptions({ licensing: { eulaAccepted: true, license: "{}" } });
        expect(options.licensing.eulaAccepted).toBe(true);
        expect(options.licensing.license).toBe("{}");
        // untouched licensing defaults survive
        expect(options.licensing.disableLicenseSupportCheck).toBe(true);
        expect(options.licensing.disableAutoUpdate).toBe(false);
    });

    it("ignores explicitly-undefined fields instead of clobbering defaults", () => {
        const options = new ServerOptions({ dotNetPath: undefined, downloadServer: false });
        expect(options.dotNetPath).toBe("dotnet");
        expect(options.downloadServer).toBe(false);
    });

    it("composes with secured()", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ravendb-embedded-"));
        const pemPath = path.join(dir, "cert.pem");
        fs.writeFileSync(pemPath, TEST_PEM_CERT);
        const options = new ServerOptions({ downloadServer: false }).secured(pemPath);
        expect(options.downloadServer).toBe(false);
        expect(options.security).toBeDefined();
        expect(options.security!.serverCertificateThumbprint).toBe(TEST_PEM_THUMBPRINT);
        fs.rmSync(dir, { recursive: true, force: true });
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

    it("computes the SHA-1 thumbprint of a PEM certificate and uses it for both thumbprints", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ravendb-embedded-"));
        const pemPath = path.join(dir, "cert.pem");
        fs.writeFileSync(pemPath, TEST_PEM_CERT);
        const options = new ServerOptions().secured(pemPath);
        expect(options.security!.clientCertificateType).toBe("pem");
        expect(options.security!.serverCertificateThumbprint).toBe(TEST_PEM_THUMBPRINT);
        expect(options.security!.clientCertificateThumbprint).toBe(TEST_PEM_THUMBPRINT);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("mentions how to compute the thumbprint in the PFX error", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ravendb-embedded-"));
        const pfxPath = path.join(dir, "cert.pfx");
        fs.writeFileSync(pfxPath, Buffer.from([0x30, 0x82, 0x01, 0x00]));
        expect(() => new ServerOptions().secured(pfxPath, "pass"))
            .toThrow(/openssl pkcs12.*Get-PfxCertificate/s);
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

describe("ServerOptions.securedWithExec", () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ravendb-embedded-")); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    function writeClientPem(): string {
        const pemPath = path.join(dir, "client.pem");
        fs.writeFileSync(pemPath, TEST_PEM_CERT);
        return pemPath;
    }

    it("validates required arguments", () => {
        const pemPath = writeClientPem();
        expect(() => new ServerOptions().securedWithExec("", "args", "THUMB", pemPath))
            .toThrow(/certLoadExec/);
        expect(() => new ServerOptions().securedWithExec("vault-cli", "args", "", pemPath))
            .toThrow(/serverCertThumbprint/);
        expect(() => new ServerOptions().securedWithExec("vault-cli", "args", "THUMB", ""))
            .toThrow(/clientCertificate/);
    });

    it("throws when security has already been set up", () => {
        const pemPath = writeClientPem();
        const options = new ServerOptions().securedWithExec("vault-cli", "args", "THUMB", pemPath);
        expect(() => options.securedWithExec("vault-cli", "args", "THUMB", pemPath))
            .toThrow(/already been setup/);
    });

    it("stores the exec settings and computes the client thumbprint from a PEM certificate", () => {
        const pemPath = writeClientPem();
        const options = new ServerOptions()
            .securedWithExec("vault-cli", "get --cert server", "SERVERTHUMB", pemPath);
        const security = options.security!;
        expect(security.certificateLoadExec).toBe("vault-cli");
        expect(security.certificateLoadExecArguments).toBe("get --cert server");
        expect(security.certificatePath).toBeUndefined();
        expect(security.clientCertificateType).toBe("pem");
        expect(security.clientCertificateThumbprint).toBe(TEST_PEM_THUMBPRINT);
        expect(security.serverCertificateThumbprint).toBe("SERVERTHUMB");
    });

    it("falls back to the server thumbprint for a PFX client certificate", () => {
        const pfxPath = path.join(dir, "client.pfx");
        fs.writeFileSync(pfxPath, Buffer.from([0x30, 0x82, 0x01, 0x00]));
        const options = new ServerOptions()
            .securedWithExec("vault-cli", "args", "SERVERTHUMB", pfxPath, "pass");
        const security = options.security!;
        expect(security.clientCertificateType).toBe("pfx");
        expect(security.clientCertificateThumbprint).toBe("SERVERTHUMB");
        expect(security.certificatePassword).toBe("pass");
    });

    it("reads the CA bundle when caCertificatePath is provided", () => {
        const pemPath = writeClientPem();
        const caPath = path.join(dir, "ca.pem");
        fs.writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n");
        const options = new ServerOptions()
            .securedWithExec("vault-cli", "args", "THUMB", pemPath, undefined, caPath);
        expect(options.security!.ca).toEqual(fs.readFileSync(caPath));
    });
});
