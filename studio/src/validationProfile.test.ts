import { beforeEach, expect, it, vi } from "vitest";
import { request } from "./api";
import { editableRules, inspectProfile, profileSource } from "./validationProfile";

vi.mock("./api", () => ({ request: vi.fn() }));
const rules = [{ name: "id-required", type: "not_null" as const, table: "public.orders", column: "id" }];
const source = profileSource(rules);

async function review(original = source) {
  return {
    apiVersion: "nostekon/profile-review/v1alpha1", kind: "PostgreSQLProfileReview", valid: true,
    profileSHA256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(original))), byte => byte.toString(16).padStart(2, "0")).join(""),
    invariants: rules, tables: ["public.orders"], warnings: [], limitations: ["Data not measured", "Snapshot counts not supplied", "Owner approval unverified"],
  };
}
beforeEach(() => vi.clearAllMocks());

it("preserves exact original text and binds structural admission to its hash", async () => {
  const original = "  " + source + "\r\n";
  const result = await review(original);
  vi.mocked(request).mockResolvedValue(new Response(JSON.stringify(result)));
  expect(await inspectProfile(original)).toEqual(result);
  expect(request).toHaveBeenCalledWith("/api/v1/backups/profile", JSON.stringify({ profile: original }), undefined);
  expect(result).not.toHaveProperty("passed");
});

it("bounds UTF-8 byte size before submitting a profile", async () => {
  for (const oversized of ["", "x".repeat(16385), "\u00e9".repeat(8193)]) await expect(inspectProfile(oversized)).rejects.toThrow("16 KiB");
  expect(request).not.toHaveBeenCalled();
});

it("rejects stale hashes, measured verdicts and malformed response shapes", async () => {
  const result = await review();
  for (const changed of [{ ...result, profileSHA256: "a".repeat(64) }, { ...result, kind: "PostgreSQLBackupReview" }, { ...result, valid: false }, { ...result, invariants: [null] }, { ...result, tables: [1] }, { ...result, warnings: null }, null]) {
    vi.mocked(request).mockResolvedValue(new Response(JSON.stringify(changed)));
    await expect(inspectProfile(source)).rejects.toThrow("Unsupported or mismatched");
  }
});

it("surfaces strict admission and capacity failures without fabricating validation", async () => {
  for (const status of [400, 413, 422, 503]) {
    vi.mocked(request).mockResolvedValue(new Response(JSON.stringify({ errors: ["admission failed"] }), { status }));
    await expect(inspectProfile(source)).rejects.toThrow("admission failed");
  }
  vi.mocked(request).mockRejectedValue(new Error("network interrupted"));
  await expect(inspectProfile(source)).rejects.toThrow("network interrupted");
});

it("keeps form parsing separate from strict Go admission and supports empty drafts", () => {
  expect(editableRules(source)).toEqual(rules);
  expect(editableRules(profileSource([]))).toEqual([]);
  for (const malformed of ["null", "{}", "[]", "not json", '{"invariants":[null]}', '{"invariants":[{"name":1}]}']) expect(editableRules(malformed)).toBeNull();
});