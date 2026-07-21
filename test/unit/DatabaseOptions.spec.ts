import { describe, it, expect } from "vitest";
import { DatabaseOptions } from "../../src/DatabaseOptions";

describe("DatabaseOptions", () => {
    it("wraps a database name in a DatabaseRecord", () => {
        const options = new DatabaseOptions("northwind");
        expect(options.databaseRecord.databaseName).toBe("northwind");
        expect(options.skipCreatingDatabase).toBe(false);
        expect(options.conventions).toBeUndefined();
    });

    it("accepts a full DatabaseRecord", () => {
        const options = new DatabaseOptions({ databaseName: "custom" });
        expect(options.databaseRecord.databaseName).toBe("custom");
    });
});
