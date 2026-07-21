import type { ChildProcess } from "node:child_process";

export function hasExited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
}

export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (hasExited(child)) {
        return Promise.resolve(true);
    }

    return new Promise<boolean>(resolve => {
        const timer = setTimeout(() => {
            child.removeListener("exit", onExit);
            resolve(false);
        }, timeoutMs);

        const onExit = () => {
            clearTimeout(timer);
            resolve(true);
        };

        child.once("exit", onExit);
    });
}
