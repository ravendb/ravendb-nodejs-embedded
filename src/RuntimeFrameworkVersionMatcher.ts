import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EmbeddedServerError } from "./Errors";
import type { ServerOptions } from "./ServerOptions";

const execFileAsync = promisify(execFile);

export const WILDCARD = "x";
export const GREATER_OR_EQUAL = "+";

export type MatchingType = "equal" | "greaterOrEqual";

function matchingTypeToString(matchingType: MatchingType): string {
    return matchingType === "equal" ? "" : GREATER_OR_EQUAL;
}

export class RuntimeFrameworkVersion {
    public major: number | null = null;
    public minor: number | null = null;
    public patch: number | null = null;
    public patchMatchingType: MatchingType = "equal";
    public suffix?: string;

    public constructor(frameworkVersion: string) {
        frameworkVersion = frameworkVersion.toLowerCase();

        const suffixes = frameworkVersion.split("-").filter(s => s.length > 0);
        if (suffixes.length !== 1) {
            frameworkVersion = suffixes[0];
            this.suffix = suffixes.slice(1).join("-");
        }

        const versions = frameworkVersion.split(".").filter(s => s.length > 0);
        for (let i = 0; i < versions.length; i++) {
            const version = versions[i].trim();

            if (!version.includes(WILDCARD)) {
                const { value, matchingType } = RuntimeFrameworkVersion._parse(version);
                this._set(i, version, value, matchingType);
                continue;
            }

            if (version !== WILDCARD) {
                throw new EmbeddedServerError(
                    `Wildcard character must be a sole part of the version string, but was '${version}'.`);
            }

            this._set(i, null, null, "equal");
        }
    }

    private static _parse(value: string): { value: number; matchingType: MatchingType } {
        let matchingType: MatchingType = "equal";
        let valueToParse = value;

        if (valueToParse.endsWith(GREATER_OR_EQUAL)) {
            matchingType = "greaterOrEqual";
            valueToParse = valueToParse.slice(0, -1);
        }

        const parsed = Number.parseInt(valueToParse, 10);
        if (Number.isNaN(parsed) || String(parsed) !== valueToParse) {
            throw new EmbeddedServerError(`Cannot parse '${value}' to a number.`);
        }

        return { value: parsed, matchingType };
    }

    private _set(index: number, valueAsString: string | null, value: number | null, matchingType: MatchingType): void {
        const assertMatchingType = (fieldName: string, expected: MatchingType | null) => {
            if (this.suffix !== undefined && matchingType !== "equal") {
                throw new EmbeddedServerError(
                    `Cannot set '${fieldName}' with value '${valueAsString}' because ` +
                    `'${matchingTypeToString(matchingType)}' is not allowed when Suffix ('${this.suffix}') is set.`);
            }
            if (expected !== null && expected !== matchingType) {
                throw new EmbeddedServerError(
                    `Cannot set '${fieldName}' with value '${valueAsString}' because ` +
                    `'${matchingTypeToString(matchingType)}' is not allowed.`);
            }
        };

        switch (index) {
            case 0:
                assertMatchingType("major", "equal");
                this.major = value;
                break;
            case 1:
                assertMatchingType("minor", "equal");
                this.minor = value;
                break;
            case 2:
                assertMatchingType("patch", null);
                this.patch = value;
                this.patchMatchingType = matchingType;
                break;
            default:
                throw new EmbeddedServerError(`Version segment index out of range: ${index}`);
        }
    }

    public toString(): string {
        const part = (num: number | null, matchingType: MatchingType): string => {
            if (num === null) {
                return WILDCARD;
            }
            return matchingType === "equal" ? String(num) : `${num}${GREATER_OR_EQUAL}`;
        };

        let version = `${part(this.major, "equal")}.${part(this.minor, "equal")}.${part(this.patch, this.patchMatchingType)}`;
        if (this.suffix !== undefined) {
            version = `${version}-${this.suffix}`;
        }
        return version;
    }

    public match(version: RuntimeFrameworkVersion): boolean {
        if (this.major !== null && this.major !== version.major) {
            return false;
        }
        if (this.minor !== null && this.minor !== version.minor) {
            return false;
        }
        if (this.patch !== null) {
            if (this.patchMatchingType === "equal") {
                if (this.patch !== version.patch) {
                    return false;
                }
            } else if (this.patch > (version.patch ?? -1)) {
                return false;
            }
        }
        return this.suffix === version.suffix;
    }
}

export function matchRuntime(runtime: RuntimeFrameworkVersion, runtimes: RuntimeFrameworkVersion[]): string {
    const sorted = [...runtimes].sort((a, b) =>
        (b.major ?? 0) - (a.major ?? 0)
        || (b.minor ?? 0) - (a.minor ?? 0)
        || (b.patch ?? 0) - (a.patch ?? 0));

    for (const version of sorted) {
        if (runtime.match(version)) {
            return version.toString();
        }
    }

    const available = sorted.map(r => `- ${r}`).join("\n");
    throw new EmbeddedServerError(
        `Could not find a matching runtime for '${runtime}'. Available runtimes:\n${available}`);
}

export function parseDotnetInfo(output: string): RuntimeFrameworkVersion[] {
    const runtimes: RuntimeFrameworkVersion[] = [];
    let insideRuntimes = false;

    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trim();

        if (line.startsWith(".NET runtimes installed:") || line.startsWith(".NET Core runtimes installed:")) {
            insideRuntimes = true;
            continue;
        }

        if (insideRuntimes && line.startsWith("Microsoft.NETCore.App")) {
            // e.g. "Microsoft.NETCore.App 6.0.5 [C:\Program Files\dotnet\shared\Microsoft.NETCore.App]"
            const values = line.split(" ");
            if (values.length < 2) {
                throw new EmbeddedServerError(
                    `Invalid runtime line. Expected 'Microsoft.NETCore.App x.x.x', but was '${line}'.`);
            }
            runtimes.push(new RuntimeFrameworkVersion(values[1]));
        }
    }

    return runtimes;
}

function needsMatch(frameworkVersion: string | null | undefined): boolean {
    if (!frameworkVersion || !frameworkVersion.trim()) {
        return false;
    }
    const lower = frameworkVersion.toLowerCase();
    return lower.includes(WILDCARD) || lower.includes(GREATER_OR_EQUAL);
}

export async function matchFrameworkVersion(options: ServerOptions): Promise<string | null> {
    if (!needsMatch(options.frameworkVersion)) {
        return options.frameworkVersion ?? null;
    }

    const runtime = new RuntimeFrameworkVersion(options.frameworkVersion!);

    let stdout: string;
    try {
        ({ stdout } = await execFileAsync(options.dotNetPath, ["--info"]));
    } catch (e: unknown) {
        throw new EmbeddedServerError(
            `Unable to execute dotnet to retrieve list of installed runtimes.\n` +
            `Command was: ${options.dotNetPath} --info\n${(e as Error).message}`);
    }

    return matchRuntime(runtime, parseDotnetInfo(stdout));
}
