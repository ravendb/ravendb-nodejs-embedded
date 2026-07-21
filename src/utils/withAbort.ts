export function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
        return promise;
    }

    if (signal.aborted) {
        return Promise.reject(signal.reason ?? new Error("The operation was aborted"));
    }

    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error("The operation was aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
            value => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            error => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            }
        );
    });
}
