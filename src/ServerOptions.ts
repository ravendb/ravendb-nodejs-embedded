import * as fs from "node:fs";
import * as path from "node:path";
import { X509Certificate } from "node:crypto";
import { EmbeddedServerError } from "./Errors";
import type { Logger } from "./Logger";

export class LicensingOptions {
    public license?: string;
    public licensePath?: string;
    public eulaAccepted = false;
    public disableAutoUpdate = false;
    public disableAutoUpdateFromApi = false;
    public disableLicenseSupportCheck = true;
    public throwOnInvalidOrMissingLicense = false;
}

export interface SecurityOptions {
    /** Set by secured() — the server loads its certificate from this file. */
    certificatePath?: string;
    certificatePassword?: string;
    /** Set by securedWithExec() — the server obtains its certificate by running this program. */
    certificateLoadExec?: string;
    certificateLoadExecArguments?: string;
    clientCertificate: Buffer;
    clientCertificateType: "pem" | "pfx";
    /** Registered as --Security.WellKnownCertificates.Admin (C# uses ClientCertificate.Thumbprint). */
    clientCertificateThumbprint: string;
    /**
     * Kept for C# API parity. The ravendb Node client offers no certificate-validation
     * hook, so unlike C# this is never used to pin the server certificate — trust the
     * server via the `ca` option instead.
     */
    serverCertificateThumbprint: string;
    ca?: Buffer;
}

export class ServerOptions {
    public frameworkVersion: string | null = "10.0.9+";
    public logsPath = path.join(process.cwd(), "RavenDB", "Logs");
    public dataDirectory = path.join(process.cwd(), "RavenDB");
    public serverDirectory = path.join(process.cwd(), "RavenDBServer");
    // Auto-download (no C# counterpart — the NuGet package ships the binaries as contentFiles;
    // here they are fetched on demand, Puppeteer-style, and cached per version+platform).
    // "latest" resolves the current stable once, then stays pinned in the cache marker so
    // later runs are offline and deterministic; pin serverVersion to move to another release.
    public serverVersion = "latest";
    public downloadServer = true;
    public downloadCacheDirectory?: string;
    public dotNetPath = "dotnet";
    public serverUrl?: string;
    public gracefulShutdownTimeout = 30_000;
    public processKillTimeout = 5_000;
    public maxServerStartupTimeDuration = 60_000;
    public commandLineArgs: string[] = [];
    public licensing = new LicensingOptions();
    public security?: SecurityOptions;
    public logger?: Logger;

    public secured(certificate: string, certPassword?: string, serverCertThumbprint?: string, caCertificatePath?: string): this {
        if (!certificate) {
            throw new EmbeddedServerError("certificate cannot be null");
        }
        if (this.security) {
            throw new EmbeddedServerError("The security has already been setup for this ServerOptions object");
        }

        const raw = fs.readFileSync(certificate);
        const head = raw.toString("utf8", 0, Math.min(raw.length, 1024));
        const isPem = head.includes("-----BEGIN");

        let thumbprint = serverCertThumbprint;
        if (!thumbprint) {
            if (!isPem) {
                throw new EmbeddedServerError(
                    "Cannot compute the thumbprint of a PFX certificate in Node.js — " +
                    "pass serverCertThumbprint explicitly to secured(). Compute it with " +
                    "`openssl pkcs12 -in cert.pfx -nodes -passin pass:<password> | " +
                    "openssl x509 -fingerprint -sha1 -noout` or, in PowerShell, " +
                    "`(Get-PfxCertificate cert.pfx).Thumbprint`");
            }
            const x509 = new X509Certificate(raw);
            thumbprint = x509.fingerprint.replace(/:/g, "");
        }

        this.security = {
            certificatePath: certificate,
            certificatePassword: certPassword,
            clientCertificate: raw,
            clientCertificateType: isPem ? "pem" : "pfx",
            // one certificate secures the server and authenticates the client, so both
            // thumbprints are the same value (mirrors C# Secured(certificate, password))
            clientCertificateThumbprint: thumbprint,
            serverCertificateThumbprint: thumbprint,
            ca: caCertificatePath !== undefined ? fs.readFileSync(caCertificatePath) : undefined
        };

        return this;
    }

    /**
     * Secures the server with a certificate obtained by running an external program
     * (`--Security.Certificate.Load.Exec`) — for certificates kept in a vault/HSM.
     * Mirrors C# Secured(certLoadExec, certExecArgs, serverCertThumbprint, clientCert).
     *
     * @param certLoadExec program the server runs to obtain its certificate
     * @param certExecArgs raw arguments string passed to that program
     * @param serverCertThumbprint thumbprint of the server certificate (cannot be computed
     *        here — the certificate is loaded by the server process)
     * @param clientCertificate path to the client certificate (PEM or PFX) used by
     *        document stores to authenticate
     * @param clientCertificatePassword password of the client certificate, if any
     * @param caCertificatePath CA bundle the client should trust
     */
    public securedWithExec(
        certLoadExec: string,
        certExecArgs: string,
        serverCertThumbprint: string,
        clientCertificate: string,
        clientCertificatePassword?: string,
        caCertificatePath?: string
    ): this {
        if (!certLoadExec) {
            throw new EmbeddedServerError("certLoadExec cannot be null");
        }
        if (certExecArgs === null || certExecArgs === undefined) {
            throw new EmbeddedServerError("certExecArgs cannot be null");
        }
        if (!serverCertThumbprint) {
            throw new EmbeddedServerError("serverCertThumbprint cannot be null");
        }
        if (!clientCertificate) {
            throw new EmbeddedServerError("clientCertificate cannot be null");
        }
        if (this.security) {
            throw new EmbeddedServerError("The security has already been setup for this ServerOptions object");
        }

        const raw = fs.readFileSync(clientCertificate);
        const head = raw.toString("utf8", 0, Math.min(raw.length, 1024));
        const isPem = head.includes("-----BEGIN");

        // WellKnownCertificates.Admin needs the CLIENT certificate thumbprint. For a PFX
        // client certificate it cannot be computed here, so fall back to the server
        // thumbprint — correct in the common case where the same certificate secures the
        // server and authenticates the client.
        const clientThumbprint = isPem
            ? new X509Certificate(raw).fingerprint.replace(/:/g, "")
            : serverCertThumbprint;

        this.security = {
            certificateLoadExec: certLoadExec,
            certificateLoadExecArguments: certExecArgs,
            certificatePassword: clientCertificatePassword,
            clientCertificate: raw,
            clientCertificateType: isPem ? "pem" : "pfx",
            clientCertificateThumbprint: clientThumbprint,
            serverCertificateThumbprint: serverCertThumbprint,
            ca: caCertificatePath !== undefined ? fs.readFileSync(caCertificatePath) : undefined
        };

        return this;
    }
}
