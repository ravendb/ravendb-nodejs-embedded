import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { EmbeddedServerError } from "./Errors";
import { matchFrameworkVersion } from "./RuntimeFrameworkVersionMatcher";
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

        const { exec, prefixArgs } = await this.getExecAndArgs(options);
        const args = [...prefixArgs, ...this.buildCommandLineArgs(options)];

        return spawn(exec, args, {
            env: this._buildEnvironment(),
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"]
        });
    }

    public static async getExecAndArgs(options: ServerOptions): Promise<{ exec: string; prefixArgs: string[] }> {
        const executable = path.join(
            options.serverDirectory,
            process.platform === "win32" ? "Raven.Server.exe" : "Raven.Server");

        if (fs.existsSync(executable)) {
            return { exec: executable, prefixArgs: [] };
        }

        const serverDllPath = path.join(options.serverDirectory, "Raven.Server.dll");
        if (!fs.existsSync(serverDllPath)) {
            throw new EmbeddedServerError(`Server file was not found: ${serverDllPath}`);
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
            args.push(`--Security.Certificate.Path=${security.certificatePath}`);
            if (security.certificatePassword !== undefined) {
                args.push(`--Security.Certificate.Password=${security.certificatePassword}`);
            }
            args.push(`--Security.WellKnownCertificates.Admin=${security.serverCertificateThumbprint}`);
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
