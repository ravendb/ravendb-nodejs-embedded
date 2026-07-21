import { describe, it, expect } from "vitest";
import {
    RuntimeFrameworkVersion,
    matchRuntime,
    parseDotnetInfo
} from "../../src/RuntimeFrameworkVersionMatcher";

describe("RuntimeFrameworkVersion parsing", () => {
    it("parses an exact version", () => {
        const v = new RuntimeFrameworkVersion("6.0.5");
        expect(v.major).toBe(6);
        expect(v.minor).toBe(0);
        expect(v.patch).toBe(5);
        expect(v.patchMatchingType).toBe("equal");
        expect(v.suffix).toBeUndefined();
        expect(v.toString()).toBe("6.0.5");
    });

    it("parses a wildcard patch", () => {
        const v = new RuntimeFrameworkVersion("6.0.x");
        expect(v.patch).toBeNull();
        expect(v.toString()).toBe("6.0.x");
    });

    it("parses greater-or-equal patch", () => {
        const v = new RuntimeFrameworkVersion("6.0.5+");
        expect(v.patch).toBe(5);
        expect(v.patchMatchingType).toBe("greaterOrEqual");
        expect(v.toString()).toBe("6.0.5+");
    });

    it("parses a suffix", () => {
        const v = new RuntimeFrameworkVersion("6.0.0-preview.7.21377.19");
        expect(v.patch).toBe(0);
        expect(v.suffix).toBe("preview.7.21377.19");
        expect(v.toString()).toBe("6.0.0-preview.7.21377.19");
    });

    it("rejects a partial wildcard like 3x", () => {
        expect(() => new RuntimeFrameworkVersion("6.0.3x")).toThrow(/sole part/);
    });

    it("rejects greater-or-equal on major", () => {
        expect(() => new RuntimeFrameworkVersion("6+.0.1")).toThrow(/not allowed/);
    });

    it("rejects greater-or-equal combined with suffix", () => {
        expect(() => new RuntimeFrameworkVersion("6.0.1+-preview")).toThrow(/not allowed/);
    });
});

describe("matchRuntime", () => {
    const runtimes = ["5.0.4", "6.0.1", "6.0.5", "7.0.2"].map(v => new RuntimeFrameworkVersion(v));

    it("wildcard patch picks the highest matching", () => {
        expect(matchRuntime(new RuntimeFrameworkVersion("6.0.x"), runtimes)).toBe("6.0.5");
    });

    it("greater-or-equal picks the highest at or above", () => {
        expect(matchRuntime(new RuntimeFrameworkVersion("6.0.2+"), runtimes)).toBe("6.0.5");
    });

    it("exact match", () => {
        expect(matchRuntime(new RuntimeFrameworkVersion("6.0.1"), runtimes)).toBe("6.0.1");
    });

    it("throws with available runtimes listed when nothing matches", () => {
        expect(() => matchRuntime(new RuntimeFrameworkVersion("8.0.x"), runtimes))
            .toThrow(/Could not find a matching runtime for '8\.0\.x'/);
    });
});

describe("parseDotnetInfo", () => {
    it("extracts Microsoft.NETCore.App runtimes", () => {
        const output = [
            ".NET SDKs installed:",
            "  8.0.100 [C:\\Program Files\\dotnet\\sdk]",
            "",
            ".NET runtimes installed:",
            "  Microsoft.AspNetCore.App 8.0.0 [C:\\Program Files\\dotnet\\shared\\Microsoft.AspNetCore.App]",
            "  Microsoft.NETCore.App 6.0.5 [C:\\Program Files\\dotnet\\shared\\Microsoft.NETCore.App]",
            "  Microsoft.NETCore.App 8.0.0 [C:\\Program Files\\dotnet\\shared\\Microsoft.NETCore.App]"
        ].join("\n");

        const runtimes = parseDotnetInfo(output);
        expect(runtimes.map(r => r.toString())).toEqual(["6.0.5", "8.0.0"]);
    });
});
