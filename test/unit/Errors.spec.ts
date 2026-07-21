import { describe, it, expect } from "vitest";
import { EmbeddedServerError, ServerStartupError, ServerStartupTimeoutError } from "../../src/Errors";

describe("Errors", () => {
    it("EmbeddedServerError has name and message", () => {
        const err = new EmbeddedServerError("boom");
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe("EmbeddedServerError");
        expect(err.message).toBe("boom");
    });

    it("ServerStartupError carries stdout and stderr", () => {
        const err = new ServerStartupError("failed", "out", "err");
        expect(err).toBeInstanceOf(EmbeddedServerError);
        expect(err.name).toBe("ServerStartupError");
        expect(err.stdout).toBe("out");
        expect(err.stderr).toBe("err");
    });

    it("ServerStartupTimeoutError extends ServerStartupError", () => {
        const err = new ServerStartupTimeoutError("timeout", "", "");
        expect(err).toBeInstanceOf(ServerStartupError);
        expect(err.name).toBe("ServerStartupTimeoutError");
    });
});
