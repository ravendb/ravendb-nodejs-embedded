import { spawn } from "node:child_process";

export function openBrowser(url: string): void {
    let command: string;
    let args: string[];

    if (process.platform === "win32") {
        command = "cmd";
        args = ["/c", "start", "", url];
    } else if (process.platform === "darwin") {
        command = "open";
        args = [url];
    } else {
        command = "xdg-open";
        args = [url];
    }

    spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}
