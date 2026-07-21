import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { withAbort } from "../../src/utils/withAbort";
import { waitForExit } from "../../src/utils/waitForExit";

describe("withAbort", () => {
    it("passes value through without a signal", async () => {
        await expect(withAbort(Promise.resolve(42))).resolves.toBe(42);
    });

    it("rejects immediately when signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(withAbort(new Promise(() => {}), controller.signal)).rejects.toThrow();
    });

    it("rejects when signal aborts while pending", async () => {
        const controller = new AbortController();
        const pending = withAbort(new Promise(() => {}), controller.signal);
        controller.abort();
        await expect(pending).rejects.toThrow();
    });
});

describe("waitForExit", () => {
    it("returns true when the process exits within the timeout", async () => {
        const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
        await expect(waitForExit(child, 10_000)).resolves.toBe(true);
    });

    it("returns false when the process does not exit in time", async () => {
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
        await expect(waitForExit(child, 200)).resolves.toBe(false);
        child.kill("SIGKILL");
    });

    it("returns true immediately for an already-exited process", async () => {
        const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
        await waitForExit(child, 10_000);
        await expect(waitForExit(child, 10)).resolves.toBe(true);
    });
});
