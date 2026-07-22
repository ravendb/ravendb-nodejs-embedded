import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { EmbeddedServerError } from "./Errors";
import { matchFrameworkVersion } from "./RuntimeFrameworkVersionMatcher";
import { ServerDownloader } from "./ServerDownloader";
import type { ServerOptions } from "./ServerOptions";

export class RavenServerRunner {
    public static async run(options: ServerOptions): Promise<ChildProcess> {
        if (!options.serverDirectory?.trim()) {
            throw new EmbeddedServerError("serverDirectory cannot be null or whitespace");
        }
        if (!options.dataDirectory?.trim()) {
            throw new EmbeddedServerError("dataDirectory cannot be null or whitespace");
        }
        if (!options.logsPath?.trim()) {
            throw new EmbeddedServerError("logsPath cannot be null or whitespace");
        }

        // Single choke point for both startServer() and restartServer(): downloads the
        // server on demand (Puppeteer-style) unless binaries are already in place.
        await ServerDownloader.ensureServerBinaries(options);

        const { exec, prefixArgs } = await this.getExecAndArgs(options);
        const args = [...prefixArgs, ...this.buildCommandLineArgs(options)];

        return spawn(exec, args, {
            env: this._buildEnvironment(),
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"]
        });
    }

    public static async getExecAndArgs(options: ServerOptions): Promise<{ exec: string; prefixArgs: string[] }> {
        const executableName = process.platform === "win32" ? "Raven.Server.exe" : "Raven.Server";

        // The distribution zip from ravendb.net nests binaries in a "Server" subdirectory,
        // while the C# NuGet layout keeps them flat — accept both.
        const candidateDirectories = [
            options.serverDirectory,
            path.join(options.serverDirectory, "Server")
        ];

        let serverDllPath: string | null = null;
        for (const directory of candidateDirectories) {
            const executable = path.join(directory, executableName);
            if (fs.existsSync(executable)) {
                return { exec: executable, prefixArgs: [] };
            }

            const dllPath = path.join(directory, "Raven.Server.dll");
            if (serverDllPath === null && fs.existsSync(dllPath)) {
                serverDllPath = dllPath;
            }
        }

        if (serverDllPath === null) {
            throw new EmbeddedServerError(
                `Server file was not found: ${path.join(options.serverDirectory, "Raven.Server.dll")}. ` +
                "Download the server from https://ravendb.net/download and extract it into serverDirectory, " +
                "or enable automatic download (ServerOptions.downloadServer = true with licensing.eulaAccepted = true, " +
                "default serverDirectory, and RAVENDB_EMBEDDED_SKIP_DOWNLOAD unset).");
        }

        if (!options.dotNetPath?.trim()) {
            throw new EmbeddedServerError("dotNetPath cannot be null or whitespace");
        }

        const prefixArgs: string[] = [];
        if (options.frameworkVersion?.trim()) {
            const frameworkVersion = await matchFrameworkVersion(options);
            if (frameworkVersion) {
                prefixArgs.push("--fx-version", frameworkVersion);
            }
        }
        prefixArgs.push(serverDllPath);

        return { exec: options.dotNetPath, prefixArgs };
    }

    public static buildCommandLineArgs(options: ServerOptions): string[] {
        const args = [...options.commandLineArgs];

        args.push(`--Embedded.ParentProcessId=${process.pid}`);

        const licensing = options.licensing;
        if (licensing) {
            if (licensing.license?.trim() && licensing.licensePath?.trim()) {
                throw new EmbeddedServerError(
                    "Only one of licence options 'license' or 'licensePath' should be specified");
            }

            if (licensing.license?.trim()) {
                args.push(`--License=${licensing.license}`);
            } else if (licensing.licensePath?.trim()) {
                args.push(`--License.Path=${licensing.licensePath}`);
            }

            args.push(`--License.Eula.Accepted=${licensing.eulaAccepted}`);
            args.push(`--License.DisableAutoUpdate=${licensing.disableAutoUpdate}`);
            args.push(`--License.DisableAutoUpdateFromApi=${licensing.disableAutoUpdateFromApi}`);
            args.push(`--License.DisableLicenseSupportCheck=${licensing.disableLicenseSupportCheck}`);
            args.push(`--License.ThrowOnInvalidOrMissingLicense=${licensing.throwOnInvalidOrMissingLicense}`);
        }

        args.push("--Setup.Mode=None");
        args.push(`--DataDir=${options.dataDirectory}`);
        args.push(`--Logs.Path=${options.logsPath}`);

        const security = options.security;
        if (security) {
            if (!options.serverUrl?.trim()) {
                options.serverUrl = "https://127.0.0.1:0";
            }
            if (security.certificateLoadExec) {
                args.push(`--Security.Certificate.Load.Exec=${security.certificateLoadExec}`);
                if (security.certificateLoadExecArguments?.trim()) {
                    args.push(`--Security.Certificate.Load.Exec.Arguments=${security.certificateLoadExecArguments}`);
                }
            } else if (security.certificatePath) {
                args.push(`--Security.Certificate.Path=${security.certificatePath}`);
                if (security.certificatePassword !== undefined) {
                    args.push(`--Security.Certificate.Password=${security.certificatePassword}`);
                }
            } else {
                throw new EmbeddedServerError(
                    "SecurityOptions must specify either certificatePath or certificateLoadExec");
            }
            args.push(`--Security.WellKnownCertificates.Admin=${security.clientCertificateThumbprint}`);
        } else if (!options.serverUrl?.trim()) {
            options.serverUrl = "http://127.0.0.1:0";
        }

        args.push(`--ServerUrl=${options.serverUrl}`);

        return args;
    }

    private static _buildEnvironment(): NodeJS.ProcessEnv {
        const env: NodeJS.ProcessEnv = {};
        for (const [key, value] of Object.entries(process.env)) {
            const upper = key.toUpperCase();
            if (upper.startsWith("APP_POOL_") || upper.startsWith("ASPNETCORE_") || upper.startsWith("IIS_")) {
                continue;
            }
            env[key] = value;
        }
        return env;
    }
}
