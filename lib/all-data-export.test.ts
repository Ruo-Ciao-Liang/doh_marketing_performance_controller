import assert from "node:assert/strict";
import test from "node:test";
import snapshot from "../data/generated/normalized.json" with { type: "json" };
import { allDataFilename, createAllDataWorkbook } from "./all-data-export.ts";

test("creates a multi-sheet workbook from the active normalized snapshot", () => {
  const workbook = createAllDataWorkbook(snapshot as unknown as Record<string, unknown>);
  assert.equal(new TextDecoder("ascii").decode(workbook.subarray(0, 2)), "PK");
  assert.ok(workbook.length > 100_000);
});

test("uses the active report end date in the filename", () => {
  assert.equal(allDataFilename("2026-07-20"), "amazon-bidding-control-all-data-2026-07-20.xlsx");
});
