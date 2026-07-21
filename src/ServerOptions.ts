import * as fs from "node:fs";
import * as path from "node:path";
import { X509Certificate } from "node:crypto";
import { EmbeddedServerError } from "./Errors";

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
    certificatePath: string;
    certificatePassword?: string;
    clientCertificate: Buffer;
    clientCertificateType: "pem" | "pfx";
    serverCertificateThumbprint: string;
}

export class ServerOptions {
    public frameworkVersion: string | null = "10.0.9+";
    public logsPath = path.join(process.cwd(), "RavenDB", "Logs");
    public dataDirectory = path.join(process.cwd(), "RavenDB");
    public serverDirectory = path.join(process.cwd(), "RavenDBServer");
    public dotNetPath = "dotnet";
    public serverUrl?: string;
    public gracefulShutdownTimeout = 30_000;
    public processKillTimeout = 5_000;
    public maxServerStartupTimeDuration = 60_000;
    public commandLineArgs: string[] = [];
    public licensing = new LicensingOptions();
    public security?: SecurityOptions;

    public secured(certificate: string, certPassword?: string, serverCertThumbprint?: string): this {
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
                    "pass serverCertThumbprint explicitly to secured()");
            }
            const x509 = new X509Certificate(raw);
            thumbprint = x509.fingerprint.replace(/:/g, "");
        }

        this.security = {
            certificatePath: certificate,
            certificatePassword: certPassword,
            clientCertificate: raw,
            clientCertificateType: isPem ? "pem" : "pfx",
            serverCertificateThumbprint: thumbprint
        };

        return this;
    }
}
