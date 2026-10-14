import { expect, test } from "@playwright/test";
import { unzipSync, zipSync } from "fflate";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function suiteBundle() {
  return Promise.all(["suite.json", "zero-loss.drillrun.json", "tail-loss.drillrun.json", "budget-loss.drillrun.json"].map(async (name) => ({
    name, mimeType: "application/json", buffer: await readFile(new URL(`../../examples/suites/postgresql-policy/${name}`, import.meta.url)),
  })));
}

function evidenceArchive(files: Awaited<ReturnType<typeof suiteBundle>>) {
  const entries = Object.fromEntries(files.map(file => [file.name, file.buffer]));
  const manifest = {
    apiVersion: "nostekon/evidence-bundle/v1alpha1", kind: "LabEvidenceBundle",
    job: { id: "a".repeat(24), status: "completed", completedAt: "2026-10-07T10:01:00Z" },
    files: files.map(file => ({ name: file.name, size: file.buffer.length, sha256: createHash("sha256").update(file.buffer).digest("hex") })),
    missingArtifacts: [],
  };
  return zipSync({ ...entries, "manifest.json": Buffer.from(JSON.stringify(manifest)) }, { level: 0 });
}

for (const width of [390, 1440]) {
  test(`interactive product and focused downloads at ${width}px`, async ({ page }) => {
    test.skip(!!process.env.NOSTEKON_APP_URL, "Public pages belong to the static site.");
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    expect(await page.locator(".hero h1").evaluate(element => getComputedStyle(element).animationName)).toBe("product-arrive");
    expect(await page.locator(".signal-dot").evaluate(element => getComputedStyle(element).animationName)).toBe("signal-pulse");
    expect(await page.locator(".hero-pipeline li").first().evaluate(element => getComputedStyle(element).animationName)).toBe("pipeline-sweep");
    await expect(page.getByRole("tab", { name: "Policy suite", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Restore report", exact: true }).click();
    await expect(page.locator("[data-showcase]")).toHaveAttribute("data-paused", "true");
    await expect(page.getByRole("tabpanel")).toContainText("V3");
    await page.getByRole("tab", { name: "Failed recovery", exact: true }).click();
    await expect(page.getByRole("tabpanel")).toContainText("Synthetic");
    await page.getByRole("tab", { name: "Failed recovery", exact: true }).press("Home");
    await expect(page.getByRole("tab", { name: "Policy suite", exact: true })).toBeFocused();
    await page.getByRole("navigation", { name: "Main navigation", exact: true }).getByRole("link", { name: "Download", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Download Nostekon", exact: true })).toBeVisible();
    if (await page.locator("[data-download-picker]").count()) {
    await expect(page.locator("[data-download-picker]")).toHaveAttribute("data-ready", "true");
    for (const platform of ["Linux", "macOS", "Windows"]) {
      const platformButton = page.getByRole("button", { name: platform, exact: true });
      if (await platformButton.isDisabled()) continue;
      await platformButton.click();
      await expect(platformButton).toHaveAttribute("aria-pressed", "true");
      for (const architecture of ["amd64", "arm64"]) {
        if (await page.getByLabel("Architecture", { exact: true }).locator(`option[value="${architecture}"]`).isDisabled()) continue;
        await page.getByLabel("Architecture", { exact: true }).selectOption(architecture);
        const download = page.locator("[data-selected-download]");
        const target = platform === "macOS" ? "darwin" : platform.toLowerCase();
        await expect(download).toHaveAttribute("href", new RegExp(`${target}_${architecture}\\.(tar\\.gz|zip)$`));
        await expect(download).toContainText(platform);
      }
    }
    await expect(page.locator(".download-checksum code")).toHaveText(/^[a-f0-9]{64}$/);
    } else {
      await expect(page.getByRole("link", { name: "View CI builds", exact: true })).toBeVisible();
      await expect(page.locator("[data-selected-download]")).toHaveCount(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("navigation", { name: "Main navigation", exact: true }).getByRole("link", { name: "Product", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Nostekon", exact: true })).toBeVisible();
    expect(await page.locator(".page-title h1").evaluate(element => getComputedStyle(element).animationName)).toBe("none");
    expect(await page.locator(".flow-track li").first().evaluate(element => getComputedStyle(element, "::before").animationName)).toBe("none");
    await page.getByRole("tab", { name: "Restore report", exact: true }).click();
    await expect(page.getByRole("tabpanel")).toBeVisible();
    await page.getByRole("navigation", { name: "Main navigation", exact: true }).getByRole("link", { name: "Overview", exact: true }).click();
    await page.getByRole("tab", { name: "Failed recovery", exact: true }).click();
    await expect(page.getByRole("tabpanel")).toContainText("Synthetic");
  });

  test(`product workflows and real preview at ${width}px`, async ({ page }) => {
    test.skip(!!process.env.NOSTEKON_APP_URL, "Product page belongs to the static site.");
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Nostekon", exact: true })).toBeVisible();
    const preview = page.locator(".shot img:visible");
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    expect((await preview.boundingBox())!.y).toBeLessThan(1000);
    for (const theme of ["dark", "light"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("[data-theme-toggle]").click();
      await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
      await page.evaluate(() => scrollTo(0, 0));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`product-${width}-${theme}.png`), fullPage: true });
    }
    const guide = await page.getByRole("link", { name: "Backup rehearsal guide", exact: true }).getAttribute("href");
    expect((await page.request.get(guide!)).status()).toBe(200);
    await page.getByRole("link", { name: "Author a validation profile", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Validation profiles", exact: true })).toBeVisible();
  });

  test(`saved history sorting filters comparison and selected originals at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const template = JSON.parse(await readFile(new URL("../../examples/runs/k3d-postgresql.run.json", import.meta.url), "utf8"));
    const originals = new Map<string, string>();
    const reportURL = process.env.NOSTEKON_APP_URL ? "/#/report" : "/demo/#/report";
    await page.goto(reportURL);
    for (const name of ["history-zulu", "history-alpha", "history-middle"]) {
      const original = JSON.stringify({ ...template, metadata: { ...template.metadata, name } });
      originals.set(name, original);
      await page.getByTestId("evidence-input").setInputFiles({ name: `${name}.json`, mimeType: "application/json", buffer: Buffer.from(original) });
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
      await page.getByRole("button", { name: "Save run", exact: true }).click();
      await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
    }
    await page.getByRole("link", { name: "Runs", exact: true }).click();
    const rows = page.locator(".saved-runs tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(rows.locator("time")).toHaveCount(3);
    await expect(rows.locator(".run-name")).toHaveText(["history-middle", "history-alpha", "history-zulu"]);
    await page.getByRole("combobox", { name: "Sort saved runs" }).selectOption("oldest");
    await expect(rows.locator(".run-name")).toHaveText(["history-zulu", "history-alpha", "history-middle"]);
    await page.getByRole("combobox", { name: "Sort saved runs" }).selectOption("name");
    await expect(rows.locator(".run-name")).toHaveText(["history-alpha", "history-middle", "history-zulu"]);
    await page.getByRole("searchbox", { name: "Search runs" }).fill(" HISTORY alpha ");
    await expect(rows).toHaveCount(1);
    await page.getByRole("combobox", { name: "Filter attachments" }).selectOption("plan");
    await expect(page.getByRole("heading", { name: "No matching runs" })).toBeVisible();
    await page.getByRole("button", { name: "Clear run filters" }).click();
    await expect(rows).toHaveCount(3);
    await page.getByRole("checkbox", { name: "Select visible saved runs" }).check();
    await expect(page.getByRole("status", { name: "Selected saved runs" })).toHaveText("3 selected");
    await expect(page.getByRole("button", { name: "Compare two runs", exact: true })).toBeDisabled();
    await page.getByRole("checkbox", { name: "Select history-middle", exact: true }).uncheck();
    await page.getByRole("button", { name: "Compare (2/2)", exact: true }).click();
    const comparison = page.getByRole("region", { name: "Run comparison" });
    await expect(comparison.getByRole("columnheader").nth(1)).toContainText("history-alpha");
    await expect(comparison).toContainText("Acknowledged-write evidence is missing");
    await expect(comparison.getByRole("row").filter({ hasText: "Acknowledged writes lost" }).getByRole("cell")).toHaveText(["Unmeasured", "Unmeasured"]);
    await page.getByRole("button", { name: "Swap baseline and candidate" }).click();
    await expect(comparison.getByRole("columnheader").nth(1)).toContainText("history-zulu");
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Back up selected runs" }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe("nostekon-selected-runs.backup.json");
    const backupText = await readFile((await download.path())!, "utf8");
    const backup = JSON.parse(backupText);
    expect(backup.runs.map((run: { evidence: string }) => run.evidence)).toEqual([originals.get("history-zulu"), originals.get("history-alpha")]);
    expect(backup.trustedKeys).toBeUndefined();
    for (const run of backup.runs) expect(run.report).toBeUndefined();
    await page.getByRole("button", { name: "Clear selected runs" }).click();
    await expect(page.getByRole("region", { name: "Run comparison" })).toHaveCount(0);
    const backupInput = page.getByTestId("run-backup-input");
    await backupInput.setInputFiles({ name: "selected.backup.json", mimeType: "application/json", buffer: Buffer.from(backupText) });
    let restore = page.getByRole("dialog", { name: "Restore 2 saved runs?" });
    await expect(restore.getByRole("status", { name: "Restore preview totals" })).toContainText("0 new, 2 already saved");
    await expect(restore.getByRole("list", { name: "Incoming run originals" }).getByRole("listitem")).toHaveCount(2);
    await page.getByRole("button", { name: "Cancel restore", exact: true }).click();
    await expect(restore).toBeHidden();
    await expect(rows).toHaveCount(3);
    await page.getByRole("button", { name: "Delete history-zulu", exact: true }).click();
    await page.getByRole("button", { name: "Delete run", exact: true }).click();
    await expect(rows).toHaveCount(2);
    await backupInput.setInputFiles({ name: "selected.backup.json", mimeType: "application/json", buffer: Buffer.from(backupText) });
    restore = page.getByRole("dialog", { name: "Restore 2 saved runs?" });
    await expect(restore.getByRole("status", { name: "Restore preview totals" })).toContainText("1 new, 1 already saved");
    const bounds = await restore.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`history-restore-${width}.png`) });
    await page.getByRole("button", { name: "Confirm restore", exact: true }).click();
    await expect(page.getByRole("status", { name: "Run backup restore result" })).toContainText("2 runs restored");
    await expect(rows).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`history-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: /Switch to .* mode/ }).click();
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`history-alternate-${width}.png`), fullPage: true });
  });

  test(`calm workspace and browsable evidence at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(process.env.NOSTEKON_APP_URL ? "/#/runs" : "/demo/#/runs");
    await expect(page.getByRole("heading", { name: "No saved runs yet", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Saved run totals" })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Workspace shortcuts" })).toBeVisible();
    const examples = page.locator(".sample-rows button");
    await expect(examples).toHaveCount(7);
    await page.getByRole("button", { name: "Recorded lab", exact: true }).click();
    await expect(examples).toHaveCount(5);
    await expect(page.getByRole("button", { name: "Recorded lab", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Synthetic", exact: true }).click();
    await expect(examples).toHaveCount(2);
    await page.getByRole("button", { name: "All examples", exact: true }).click();
    await expect(examples).toHaveCount(7);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => scrollTo(0, 0));
    const header = await page.locator(".topbar").boundingBox();
    const heading = await page.getByRole("heading", { name: "Recovery runs", exact: true }).boundingBox();
    expect(heading!.y).toBeGreaterThanOrEqual(header!.y + header!.height);
    await page.screenshot({ path: test.info().outputPath(`workspace-${width}.png`), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: /Switch to .* mode/ }).click();
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: test.info().outputPath(`workspace-alternate-${width}.png`), fullPage: true, animations: "disabled" });
    await page.getByRole("link", { name: "Author a validation profile", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Validation profiles", exact: true })).toBeVisible();
    expect(await page.locator(".profile-workspace").evaluate(element => getComputedStyle(element).animationName)).toBe("workspace-arrive");
    await page.getByRole("link", { name: "Runs", exact: true }).click();
    await page.getByRole("link", { name: "Review a policy suite", exact: true }).click();
    await expect(page).toHaveURL(/#\/suite$/);
  });

  test(`semantic profile authoring and exact originals at ${width}px`, async ({ page }) => {
    const inventory = await readFile(new URL("../../examples/validation-profiles/inventory.json", import.meta.url));
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(process.env.NOSTEKON_APP_URL ? "/#/profiles" : "/demo/#/profiles");
    await expect(page.getByRole("heading", { name: "Validation profiles", exact: true })).toBeVisible();
    page.once("dialog", dialog => dialog.accept());
    await page.getByLabel("Profile template").selectOption("inventory");
    const status = page.getByRole("status", { name: "Profile validation" });
    await expect(status).toContainText("Valid structure");
    await expect(status).toContainText("Data not measured");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download profile", exact: true }).click();
    expect(await readFile((await (await download).path())!)).toEqual(inventory);
    await page.getByLabel("Rule 1 name", { exact: true }).fill("products-id-unique");
    await expect(page.getByRole("alert")).toContainText("duplicate invariant");
    await expect(page.getByRole("button", { name: "Download profile", exact: true })).toBeDisabled();
    await page.getByLabel("Rule 1 name", { exact: true }).fill("products-id-required");
    await expect(status).toContainText("Valid structure");
    await page.getByRole("button", { name: "Remove rule 1", exact: true }).click();
    await expect(page.getByText(/lacks required and unique parent-key coverage/)).toBeVisible();
    await page.getByRole("button", { name: "Add rule", exact: true }).click();
    await expect(page.getByRole("button", { name: "Download profile", exact: true })).toBeDisabled();
    await page.getByLabel("Rule 10 name", { exact: true }).fill("products-id-required");
    await page.getByLabel("Rule 10 table", { exact: true }).fill("public.products");
    await page.getByLabel("Rule 10 column", { exact: true }).fill("id");
    await expect(status).toContainText("Valid structure");
    const authoredDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download profile", exact: true }).click();
    const authored = await readFile((await (await authoredDownload).path())!);
    const authoredPath = test.info().outputPath("authored-profile.json");
    await writeFile(authoredPath, authored);
    const cli = JSON.parse(execFileSync("go", ["run", "./cmd/nostekon-report", "--validation-profile", authoredPath], { cwd: new URL("../../", import.meta.url), encoding: "utf8" }));
    expect(cli.valid).toBe(true);
    expect(cli.profileSHA256).toBe(createHash("sha256").update(authored).digest("hex"));
    expect(cli.invariants).toEqual(JSON.parse(authored.toString()).invariants);
    expect(cli.tables).toEqual(["public.products", "public.stock", "public.warehouses"]);
    expect(cli).not.toHaveProperty("passed");
    await page.reload();
    await expect(page.getByLabel("Rule 10 name", { exact: true })).toHaveValue("products-id-required");
    await expect(status).toContainText("Valid structure");
    await page.getByTestId("profile-input").setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from("null") });
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByLabel("Rule 10 name", { exact: true })).toHaveValue("products-id-required");
    await page.getByTestId("profile-input").setInputFiles({ name: "inventory.json", mimeType: "application/json", buffer: inventory });
    await expect(status).toContainText("Valid structure");
    const exported = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download profile", exact: true }).click();
    expect(await readFile((await (await exported).path())!)).toEqual(inventory);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`profiles-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: /Switch to .* mode/ }).click();
    await page.screenshot({ path: test.info().outputPath(`profiles-alternate-theme-${width}.png`), fullPage: true });
  });

  test(`semantic profile rejects ambiguous JSON and caps authoring at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(process.env.NOSTEKON_APP_URL ? "/#/profiles" : "/demo/#/profiles");
    const source = JSON.stringify({ apiVersion: "nostekon/validation-profile/v1alpha1", kind: "PostgreSQLValidationProfile", invariants: Array.from({ length: 20 }, (_, index) => ({ name: `required-${index + 1}`, type: "not_null", table: "public.orders", column: "id" })) });
    await page.getByTestId("profile-input").setInputFiles({ name: "twenty.json", mimeType: "application/json", buffer: Buffer.from(source) });
    await expect(page.getByRole("status", { name: "Profile validation" })).toContainText("Valid structure");
    await expect(page.getByRole("button", { name: "Add rule", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Move rule 20 up", exact: true }).click();
    await expect(page.getByLabel("Rule 19 name", { exact: true })).toHaveValue("required-20");
    await page.getByText("Profile JSON", { exact: true }).click();
    const duplicate = '{"apiVersion":"nostekon/validation-profile/v1alpha1","kind":"PostgreSQLValidationProfile","invariants":[],"invariants":[]}';
    await page.getByLabel("Profile JSON", { exact: true }).fill(duplicate);
    await expect(page.getByRole("alert")).toContainText(/duplicate/);
    await expect(page.getByRole("button", { name: "Download profile", exact: true })).toBeDisabled();
    await page.reload();
    await expect(page.getByRole("alert")).toContainText(/duplicate/);
    await page.getByText("Profile JSON", { exact: true }).click();
    await expect(page.getByLabel("Profile JSON", { exact: true })).toHaveValue(duplicate);
  });

  test(`saved backup plans survive reload and original-only history backup at ${width}px`, async ({ page }) => {
    const [plan, evidence] = await Promise.all([
      readFile(new URL("./postgresql-semantic-rehearsal.plan.json", import.meta.url)),
      readFile(new URL("./postgresql-semantic-rehearsal.run.json", import.meta.url)),
    ]);
    const name = JSON.parse(evidence.toString()).metadata.name;
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(process.env.NOSTEKON_APP_URL ? "/#/report" : "/demo/#/report");
    await page.getByTestId("evidence-input").setInputFiles({ name: "original.run.json", mimeType: "application/json", buffer: evidence });
    await expect(page.getByRole("heading", { name: "Failed at V4: orders-id-required", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Plan review", exact: true }).click();
    await page.getByTestId("backup-plan-input").setInputFiles({ name: "original.plan.json", mimeType: "application/json", buffer: plan });
    const gate = page.getByRole("status", { name: "Backup plan gate" });
    await expect(gate).toContainText("Failed");
    const preflightBuffer = Buffer.from(JSON.stringify({
      apiVersion: "nostekon/backup-preflight/v1alpha1",
      kind: "PostgreSQLBackupPreflight",
      passed: true,
      backupMatches: true,
      backup: { sha256: "6d9a0a2794de72ac5c986ccbfa9487c2d7c6a2e2935b27cb0916bac3bf092c50", bytes: 3323 },
      planSHA256: "988df63edaa9bf7f3f749d22de856f23aec91dfcd167df4e1d5163a8ebb6e7e1",
      imageId: "sha256:2698c2096ca78a41ae7477580afb30fe36d5368564511b2ea593dbfb26401fdd",
      requestedLevel: "V4",
      checks: [
        { name: "backup-plan-binding", passed: true, detail: "Frozen archive checksum and size match the plan" },
        { name: "snapshot-count-coverage", passed: true, detail: "At least one table count is declared" },
        { name: "local-linux-daemon", passed: true, detail: "Local Linux Docker daemon on a supported native architecture" },
        { name: "daemon-resource-floor", passed: true, detail: "At least 512 MiB and one CPU advertised; free capacity untested" },
        { name: "native-pinned-image", passed: true, detail: "Exact cached Linux image matches native daemon architecture" },
      ],
      limitations: [
        "Technical prerequisites only; not approval, sanitization or dedicated-host confirmation",
        "Header/byte binding only; full archive validity and restore success untested",
        "No restore ran; capture authenticity, incident RTO and acknowledged-write RPO unmeasured",
      ],
    }, null, 2) + "\n");
    await page.getByTestId("backup-preflight-input").setInputFiles({ name: "original.preflight.json", mimeType: "application/json", buffer: preflightBuffer });
    await expect(page.getByRole("status", { name: "Backup preflight gate" })).toContainText("Ready");
    await page.getByRole("button", { name: "Save run", exact: true }).click();
    await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Runs", exact: true }).click();
    await page.reload();
    await expect(page.locator(".saved-runs tbody").getByText("Restore plan attached", { exact: true })).toBeVisible();
    await expect(page.locator(".saved-runs tbody").getByText("Preflight attached", { exact: true })).toBeVisible();
    const planDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: `Download restore plan for ${name}`, exact: true }).click();
    expect(await readFile((await (await planDownload).path())!)).toEqual(plan);
    const preflightDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: `Download backup preflight for ${name}`, exact: true }).click();
    expect(await readFile((await (await preflightDownload).path())!)).toEqual(preflightBuffer);
    const backupDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Back up saved runs", exact: true }).click();
    const backupBytes = await readFile((await (await backupDownload).path())!);
    const backup = JSON.parse(backupBytes.toString());
    expect(backup.apiVersion).toBe("nostekon/run-backup/v3alpha1");
    expect(backup.runs[0].backupPlan).toBe(plan.toString());
    expect(backup.runs[0].backupPlanSha256).toBe(createHash("sha256").update(plan).digest("hex"));
    expect(backup.runs[0].backupPreflight).toBe(preflightBuffer.toString());
    expect(backup.runs[0].backupPreflightSha256).toBe(createHash("sha256").update(preflightBuffer).digest("hex"));
    expect(backup.runs[0]).not.toHaveProperty("backupReview");
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("tab", { name: "Plan review", exact: true }).click();
    await expect(gate).toContainText("Failed");
    await expect(gate).toContainText("Complete");
    await expect(gate).toContainText("Matches");
    await expect(gate).toContainText("Unauthenticated provenance");
    await expect(page.getByRole("status", { name: "Backup preflight gate" })).toContainText("Ready");
    await page.getByRole("link", { name: "Runs", exact: true }).click();
    await page.getByRole("button", { name: `Delete ${name}`, exact: true }).click();
    await page.getByRole("button", { name: "Delete run", exact: true }).click();
    await expect(page.getByText("No saved runs yet", { exact: true })).toBeVisible();
    await page.getByTestId("run-backup-input").setInputFiles({ name: "history.backup.json", mimeType: "application/json", buffer: backupBytes });
    await page.getByRole("button", { name: "Confirm restore", exact: true }).click();
    await expect(page.getByRole("status", { name: "Run backup restore result" })).toContainText("1 run restored");
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("tab", { name: "Plan review", exact: true }).click();
    await expect(gate).toContainText("Failed");
    await expect(page.getByRole("status", { name: "Backup preflight gate" })).toContainText("Ready");
    await page.evaluate(() => {
      const original = crypto.subtle.digest.bind(crypto.subtle);
      crypto.subtle.digest = (algorithm, data) => new Promise<void>(resolve => {
        (window as Window & { releaseRunSave?: () => void }).releaseRunSave = () => {
          crypto.subtle.digest = original;
          resolve();
        };
      }).then(() => original(algorithm, data));
    });
    await page.getByRole("button", { name: "Save run", exact: true }).click();
    await expect(page.getByRole("button", { name: "Saving...", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Remove restore plan", exact: true }).click();
    await page.evaluate(() => (window as Window & { releaseRunSave?: () => void }).releaseRunSave!());
    await expect(page.getByRole("button", { name: "Save run", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Saved", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Save run", exact: true }).click();
    await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Runs", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    await expect(page.locator(".saved-runs tbody").getByText("Restore plan attached", { exact: true })).toHaveCount(0);
  });

  test(`independent backup plan gate and portable originals round-trip at ${width}px`, async ({ page }, testInfo) => {
    const planPath = new URL("./postgresql-semantic-rehearsal.plan.json", import.meta.url);
    const runPath = new URL("./postgresql-semantic-rehearsal.run.json", import.meta.url);
    const [plan, evidence] = await Promise.all([readFile(planPath), readFile(runPath)]);
    const root = new URL("../../", import.meta.url);
    let native = "";
    try { execFileSync("go", ["run", "./cmd/nostekon-report", "--backup-plan", planPath.pathname, runPath.pathname], { cwd: root }); }
    catch (error) { native = (error as { stdout: Buffer }).stdout.toString(); }
    const expected = JSON.parse(native);
    expect(expected).toMatchObject({ passed: false, complete: true, evidenceMatches: true });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(process.env.NOSTEKON_APP_URL ? "/#/report" : "/demo/#/report");
    await page.getByTestId("evidence-input").setInputFiles({ name: "failed.run.json", mimeType: "application/json", buffer: evidence });
    await expect(page.locator(".verdict.failed")).toBeVisible();
    await page.getByRole("tab", { name: "Plan review", exact: true }).click();
    await page.getByTestId("backup-plan-input").setInputFiles({ name: "reviewed.plan.json", mimeType: "application/json", buffer: plan });
    const gate = page.getByRole("status", { name: "Backup plan gate" });
    await expect(gate).toContainText("Failed");
    await expect(gate).toContainText("Complete");
    await expect(gate).toContainText("Matches");
    await expect(gate).toContainText("Unauthenticated provenance");
    await expect(gate).toContainText(expected.planSHA256);
    const reviewDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download independent backup review", exact: true }).click();
    expect(JSON.parse((await readFile((await (await reviewDownload).path())!)).toString())).toEqual(expected);
    const archiveDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export backup bundle", exact: true }).click();
    const archive = await readFile((await (await archiveDownload).path())!);
    const entries = unzipSync(archive);
    expect(Object.keys(entries).sort()).toEqual(["manifest.json", "plan.json", "review.json", "run.json"]);
    expect(Buffer.from(entries["plan.json"])).toEqual(plan);
    expect(Buffer.from(entries["run.json"])).toEqual(evidence);
    expect(JSON.parse(Buffer.from(entries["review.json"]).toString())).toEqual(expected);
    const manifest = JSON.parse(Buffer.from(entries["manifest.json"]).toString());
    for (const name of ["plan.json", "run.json", "review.json"]) {
      expect(manifest.files[name]).toEqual({ bytes: entries[name].length, sha256: createHash("sha256").update(entries[name]).digest("hex") });
    }
    const forged = Buffer.from(JSON.stringify({ ...expected, passed: true, provenance: { status: "verified" } }));
    entries["review.json"] = forged;
    manifest.files["review.json"] = { bytes: forged.length, sha256: createHash("sha256").update(forged).digest("hex") };
    entries["manifest.json"] = Buffer.from(JSON.stringify(manifest));
    await page.getByRole("button", { name: "Remove restore plan", exact: true }).click();
    await expect(gate).toHaveCount(0);
    await page.getByTestId("backup-bundle-input").setInputFiles({ name: "forged-review.zip", mimeType: "application/zip", buffer: Buffer.from(zipSync(entries, { level: 0 })) });
    await expect(page.getByRole("tab", { name: "Plan review", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(gate).toContainText("Failed");
    await expect(gate).toContainText("Unauthenticated provenance");
    await page.getByRole("tab", { name: "Evidence JSON", exact: true }).click();
    await expect(page.locator(".backup-review-result:visible")).toHaveCount(0);
    await page.getByRole("tab", { name: "Plan review", exact: true }).click();
    await expect(gate).toContainText("Complete");
    for (const theme of ["dark", "light"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("[data-theme-toggle]").click();
      await page.screenshot({ path: testInfo.outputPath(`backup-plan-gate-${width}-${theme}.png`), fullPage: true });
      const bounds = await page.locator(".backup-workbench").boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(await page.locator(".backup-workbench").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.locator(".backup-hashes code").evaluateAll(elements => elements.every(element => element.getBoundingClientRect().right <= innerWidth))).toBe(true);
    }
    await page.getByTestId("backup-plan-input").setInputFiles({ name: "invalid.plan.json", mimeType: "application/json", buffer: Buffer.from("{}") });
    await expect(gate).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Export backup bundle", exact: true })).toBeDisabled();
    await expect(page.locator(".backup-workbench [role=alert]")).toBeVisible();
    await page.getByTestId("backup-plan-input").setInputFiles({ name: "oversized.plan.json", mimeType: "application/json", buffer: Buffer.alloc(16385, 32) });
    await expect(page.locator(".backup-workbench [role=alert]")).toContainText("16384 bytes");
    const altered = JSON.parse(plan.toString()); altered.tables["public.orders_bad"] = 4;
    await page.getByTestId("backup-plan-input").setInputFiles({ name: "different.plan.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(altered)) });
    await expect(gate).toContainText("Mismatch");
    await expect(gate).toContainText("Failed");
    await page.getByRole("tab", { name: "Report", exact: true }).click();
    await expect(page.locator(".verdict.failed")).toBeVisible();
    await page.getByRole("tab", { name: "Plan review", exact: true }).click();
    await page.getByTestId("backup-bundle-input").setInputFiles({ name: "broken.zip", mimeType: "application/zip", buffer: Buffer.from("not a zip") });
    await expect(page.locator(".backup-workbench [role=alert]")).toBeVisible();
    await expect(gate).toHaveCount(0);
    await page.getByTestId("backup-plan-input").setInputFiles({ name: "reviewed.plan.json", mimeType: "application/json", buffer: plan });
    await expect(gate).toContainText("Failed");
    const consistent = JSON.parse(evidence.toString());
    for (const check of consistent.status.checks) if (check.level === "V4") { check.passed = true; check.detail = check.detail.replace("violations: 1", "violations: 0"); }
    await page.getByTestId("evidence-input").setInputFiles({ name: "synthetic-passing.run.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(consistent)) });
    await expect(page.locator(".verdict.verified")).toBeVisible();
    await page.getByRole("tab", { name: "Plan review", exact: true }).click();
    await expect(gate).toContainText("Passed");
    await expect(gate).toContainText("Complete");
    await expect(gate).toContainText("Unauthenticated provenance");
    expect(await page.locator(".backup-pass").evaluate(element => getComputedStyle(element).color)).toBe("rgb(23, 121, 74)");
    const missing = consistent.status.checks.find((check: { name: string }) => check.name === "orders-id-required");
    missing.passed = false; missing.detail = "not_null: public.orders_bad.id; query failed; no raw database output retained";
    await page.getByTestId("evidence-input").setInputFiles({ name: "synthetic-unmeasured.run.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(consistent)) });
    await expect(page.locator(".verdict.failed")).toBeVisible();
    await page.getByRole("tab", { name: "Plan review", exact: true }).click();
    await expect(gate).toContainText("Failed");
    await expect(gate).toContainText("Incomplete");
    await expect(gate).toContainText("Matches");
    await expect(page.getByRole("button", { name: "Export backup bundle", exact: true })).toBeEnabled();
    const preflightObject = {
      apiVersion: "nostekon/backup-preflight/v1alpha1",
      kind: "PostgreSQLBackupPreflight",
      passed: true,
      backupMatches: true,
      backup: { sha256: "6d9a0a2794de72ac5c986ccbfa9487c2d7c6a2e2935b27cb0916bac3bf092c50", bytes: 3323 },
      planSHA256: expected.planSHA256,
      imageId: "sha256:2698c2096ca78a41ae7477580afb30fe36d5368564511b2ea593dbfb26401fdd",
      requestedLevel: "V4",
      checks: [
        { name: "backup-plan-binding", passed: true, detail: "Frozen archive checksum and size match the plan" },
        { name: "snapshot-count-coverage", passed: true, detail: "At least one table count is declared" },
        { name: "local-linux-daemon", passed: true, detail: "Local Linux Docker daemon on a supported native architecture" },
        { name: "daemon-resource-floor", passed: true, detail: "At least 512 MiB and one CPU advertised; free capacity untested" },
        { name: "native-pinned-image", passed: true, detail: "Exact cached Linux image matches native daemon architecture" },
      ],
      limitations: [
        "Technical prerequisites only; not approval, sanitization or dedicated-host confirmation",
        "Header/byte binding only; full archive validity and restore success untested",
        "No restore ran; capture authenticity, incident RTO and acknowledged-write RPO unmeasured",
      ],
    };
    const preflightBuffer = Buffer.from(JSON.stringify(preflightObject, null, 2) + "\n");
    await page.getByTestId("backup-preflight-input").setInputFiles({ name: "orders-preflight.json", mimeType: "application/json", buffer: preflightBuffer });
    const preflightGate = page.getByRole("status", { name: "Backup preflight gate" });
    await expect(preflightGate).toContainText("Ready");
    await expect(preflightGate).toContainText("Matches");
    await expect(preflightGate).toContainText("Metadata-only preflight · no restore ran");
    const preflightOriginalDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download original backup preflight", exact: true }).click();
    expect(await readFile((await (await preflightOriginalDownload).path())!)).toEqual(preflightBuffer);
    const v2BundleDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export backup bundle", exact: true }).click();
    const v2Archive = await readFile((await (await v2BundleDownload).path())!);
    const v2Entries = unzipSync(v2Archive);
    expect(Object.keys(v2Entries).sort()).toEqual(["manifest.json", "plan.json", "preflight.json", "review.json", "run.json"]);
    expect(Buffer.from(v2Entries["preflight.json"])).toEqual(preflightBuffer);
    expect(JSON.parse(Buffer.from(v2Entries["manifest.json"]).toString()).apiVersion).toBe("nostekon/backup-bundle/v2alpha1");
    await page.getByRole("button", { name: "Remove restore plan", exact: true }).click();
    await expect(preflightGate).toHaveCount(0);
    await page.getByTestId("backup-bundle-input").setInputFiles({ name: "v2-bundle.zip", mimeType: "application/zip", buffer: v2Archive });
    await expect(preflightGate).toContainText("Ready");
    const blockedPreflight = {
      ...preflightObject,
      passed: false,
      checks: preflightObject.checks.map(check => check.name === "native-pinned-image" ? { ...check, passed: false, detail: "Pinned image unavailable or metadata query failed; no image pulled" } : check),
    };
    await page.getByTestId("backup-preflight-input").setInputFiles({ name: "blocked-preflight.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(blockedPreflight)) });
    await expect(preflightGate).toContainText("Blocked");
    await expect(preflightGate).toContainText("native-pinned-image");
    await page.getByRole("button", { name: "Remove backup preflight", exact: true }).click();
    await expect(preflightGate).toHaveCount(0);
  });

  test(`grouped footer has working product, source, docs and legal destinations at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const footer = page.getByRole("contentinfo");
    for (const group of ["Product", "Open Source", "Docs", "Legal"]) {
      await expect(footer.getByRole("navigation", { name: `Footer ${group}`, exact: true })).toBeVisible();
    }
    await expect(footer).toContainText("Nostekon™");
    for (const theme of ["dark", "light"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("[data-theme-toggle]").click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await footer.screenshot({ path: testInfo.outputPath(`footer-${width}-${theme}.png`) });
    }
    const destinations = await footer.locator('a[href^="/"]').evaluateAll(links => links.map(link => link.getAttribute("href")!));
    for (const href of new Set(destinations)) {
      const response = await page.request.get(href.split("#")[0]);
      expect(response.status(), href).toBe(200);
    }
    await footer.getByRole("link", { name: "Trademark", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Trademark", exact: true })).toBeVisible();
    await expect(page.locator("main")).toContainText("name and logo");
    await expect(page.locator("main")).toContainText("not a registration");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`monochrome theme icons preserve state across product and Studio at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/", "/demo/"]) {
      await page.goto(path);
      const toggle = page.locator("[data-theme-toggle]");
      const icon = toggle.locator("svg:visible");
      await expect(icon).toHaveCount(1);
      await expect(icon).toHaveAttribute("stroke", "currentColor");
      await expect(toggle).toHaveText("");
      const before = await page.locator("html").getAttribute("data-theme");
      await expect(icon).toHaveAttribute("data-theme-icon", before === "dark" ? "sun" : "moon");
      await toggle.click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", before === "dark" ? "light" : "dark");
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", before === "dark" ? "light" : "dark");
      await expect(toggle.locator("svg:visible")).toHaveAttribute("data-theme-icon", before === "dark" ? "moon" : "sun");
    }
  });

  test(`signature trust verifies native Go sidecars without upgrading recovery at ${width}px`, async ({ page, context, browser, baseURL }, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), "nostekon-signature-"));
    const privatePath = join(directory, "private.pem");
    const publicPath = join(directory, "public.pem");
    const sidecarPath = join(directory, "run.attestation.json");
    const root = new URL("../../", import.meta.url);
    const evidencePath = new URL("../../examples/runs/k3d-ledger-tail-loss.run.json", import.meta.url).pathname;
    try {
      execFileSync("go", ["run", "./cmd/nostekon-attest", "keygen", "--private", privatePath, "--public", publicPath], { cwd: root });
      execFileSync("go", ["run", "./cmd/nostekon-attest", "sign", "--evidence", evidencePath, "--key", privatePath, "--output", sidecarPath], { cwd: root });
      const evidence = await readFile(evidencePath);
      const publicKey = await readFile(publicPath);
      const sidecar = await readFile(sidecarPath);
      await page.setViewportSize({ width, height: 1000 });
      const reportURL = process.env.NOSTEKON_APP_URL ? "/#/report" : "/demo/#/report";
      await page.goto(reportURL);
      await page.getByTestId("evidence-input").setInputFiles({ name: "failed.run.json", mimeType: "application/json", buffer: evidence });
      await expect(page.locator(".verdict.failed")).toBeVisible();
      await page.getByTestId("attestation-input").setInputFiles({ name: "run.attestation.json", mimeType: "application/json", buffer: sidecar });
      await page.getByRole("button", { name: "Public keys", exact: true }).click();
      await page.getByLabel("Public key label").fill("Lab operator");
      await page.getByTestId("public-key-input").setInputFiles({ name: "public.pem", mimeType: "application/x-pem-file", buffer: publicKey });
      await expect(page.getByRole("row", { name: /Lab operator/ })).toContainText("Not trusted");
      const trustAction = await page.getByRole("button", { name: "Trust public key", exact: true }).boundingBox();
      expect(trustAction!.x).toBeGreaterThanOrEqual(0);
      expect(trustAction!.x + trustAction!.width).toBeLessThanOrEqual(width);
      await page.getByRole("button", { name: "Trust public key", exact: true }).click();
      await expect(page.getByRole("button", { name: "Confirm trust", exact: true })).toBeDisabled();
      await page.getByRole("checkbox", { name: /I verified this fingerprint/ }).check();
      await page.getByRole("button", { name: "Confirm trust", exact: true }).click();
      await expect(page.getByRole("row", { name: /Lab operator/ })).toContainText("Trusted locally");
      await page.getByRole("button", { name: "Close public keys", exact: true }).click();
      await page.getByRole("button", { name: "Verify signature", exact: true }).click();
      await expect(page.getByRole("status", { name: "Signature verification" })).toContainText("Signature valid");
      await expect(page.locator(".verdict.failed")).toBeVisible();
      await page.getByRole("button", { name: "Save run", exact: true }).click();
      await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeDisabled();
      await page.goto(reportURL.replace("/report", "/runs"));
      await expect(page.locator(".saved-runs")).toContainText("Attestation attached");
      await expect(page.getByRole("link", { name: "Run a lab drill" })).toHaveAttribute("href", process.env.NOSTEKON_APP_URL ? "https://github.com/jagarkarlo/nostekon/blob/main/site/src/content/docs/guides/k3d-isolated-restore.md" : "/docs/guides/k3d-isolated-restore/");
      for (const name of [/^Download evidence for/, /^Download attestation for/, /^Delete checkride/]) {
        const bounds = await page.getByRole("button", { name }).boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      }
      await page.screenshot({ path: testInfo.outputPath(`saved-signed-runs-${width}.png`), fullPage: true });
      const attachmentDownload = page.waitForEvent("download");
      await page.getByRole("button", { name: /^Download attestation for/ }).click();
      expect(await readFile((await (await attachmentDownload).path())!)).toEqual(sidecar);
      const evidenceDownload = page.waitForEvent("download");
      await page.getByRole("button", { name: /^Download evidence for/ }).click();
      expect(await readFile((await (await evidenceDownload).path())!)).toEqual(evidence);
      await page.locator(".saved-runs .run-name").click();
      await expect(page.getByRole("button", { name: "Replace attestation", exact: true })).toBeVisible();
      await expect(page.getByRole("status", { name: "Signature verification" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Download signed originals", exact: true })).toBeDisabled();
      await page.getByRole("button", { name: "Verify signature", exact: true }).click();
      await expect(page.getByRole("status", { name: "Signature verification" })).toContainText("Signature valid");
      await expect(page.locator(".verdict.failed")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`signature-trust-${width}.png`), fullPage: true });
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Download signed originals", exact: true }).click();
      const archive = unzipSync(await readFile((await (await download).path())!));
      expect(Buffer.from(archive["nostekon.run.json"])).toEqual(evidence);
      expect(Buffer.from(archive["nostekon.run.attestation.json"])).toEqual(sidecar);
      expect(Buffer.from(archive["public-key.pem"])).toEqual(publicKey);
      expect(Object.keys(archive).sort()).toEqual(["nostekon.run.json", "nostekon.run.attestation.json", "public-key.pem", "signature-check.json"].sort());
      expect(JSON.parse(Buffer.from(archive["signature-check.json"]).toString())).toMatchObject({ signatureValid: true, trustSource: "selected-public-key", evidenceSHA256: createHash("sha256").update(evidence).digest("hex") });
      const exportedEvidence = join(directory, "exported.run.json");
      const exportedSidecar = join(directory, "exported.attestation.json");
      await writeFile(exportedEvidence, archive["nostekon.run.json"]);
      await writeFile(exportedSidecar, archive["nostekon.run.attestation.json"]);
      execFileSync("go", ["run", "./cmd/nostekon-attest", "verify", "--evidence", exportedEvidence, "--attestation", exportedSidecar, "--trusted-key", publicPath], { cwd: root });
      const recipient = await browser.newContext({ baseURL, viewport: { width, height: 1000 } });
      try {
        const transferred = await recipient.newPage();
        await transferred.goto(reportURL);
        const imported = { name: "signed-originals.zip", mimeType: "application/zip", buffer: Buffer.from(zipSync({ ...archive, "signature-check.json": Buffer.from('{"signatureValid":true,"trusted":true,"evidenceSHA256":"forged receipt"}') }, { level: 0 })) };
        const importButton = await transferred.getByRole("button", { name: "Import signed archive", exact: true }).boundingBox();
        expect(importButton!.x + importButton!.width).toBeLessThanOrEqual(width);
        await transferred.getByTestId("signed-originals-input").setInputFiles(imported);
        await expect(transferred.getByRole("status", { name: "Signed archive import" })).toContainText("receipt discarded");
        await expect(transferred.getByRole("button", { name: "Verify signature", exact: true })).toBeDisabled();
        await expect(transferred.getByRole("status", { name: "Signature verification" })).toHaveCount(0);
        await expect(transferred.locator(".verdict.failed")).toBeVisible();
        await transferred.getByRole("button", { name: "Public keys", exact: true }).click();
        await expect(transferred.getByRole("dialog").locator("tbody tr")).toHaveCount(1);
        await expect(transferred.getByRole("dialog")).toContainText("Not trusted");
        await transferred.getByRole("button", { name: "Trust public key", exact: true }).click();
        await transferred.getByRole("checkbox", { name: /I verified this fingerprint/ }).check();
        await transferred.getByRole("button", { name: "Confirm trust", exact: true }).click();
        await transferred.getByRole("button", { name: "Close public keys", exact: true }).click();
        await transferred.getByRole("button", { name: "Verify signature", exact: true }).click();
        await expect(transferred.getByRole("status", { name: "Signature verification" })).toContainText("Signature valid");
        await expect(transferred.locator(".verdict.failed")).toBeVisible();
        const reexport = transferred.waitForEvent("download");
        await transferred.getByRole("button", { name: "Download signed originals", exact: true }).click();
        const rechecked = unzipSync(await readFile((await (await reexport).path())!));
        for (const name of ["nostekon.run.json", "nostekon.run.attestation.json", "public-key.pem"]) expect(rechecked[name]).toEqual(archive[name]);
        expect(JSON.parse(Buffer.from(rechecked["signature-check.json"]).toString())).toMatchObject({ signatureValid: true, evidenceSHA256: createHash("sha256").update(evidence).digest("hex") });
        await transferred.getByTestId("signed-originals-input").setInputFiles({ ...imported, buffer: Buffer.from(zipSync({ ...archive, "nostekon.run.json": Buffer.concat([evidence, Buffer.from("\n")]) }, { level: 0 })) });
        await expect(transferred.getByRole("status", { name: "Signed archive import" })).toBeVisible();
        await expect(transferred.getByRole("status", { name: "Signature verification" })).toHaveCount(0);
        await transferred.getByRole("button", { name: "Verify signature", exact: true }).click();
        await expect(transferred.getByRole("alert")).toContainText("digest does not match");
        await expect(transferred.getByRole("button", { name: "Download signed originals", exact: true })).toBeDisabled();
        let keyRequests = 0;
        transferred.on("request", outgoing => { if (outgoing.url().endsWith("/attestations/key")) keyRequests++; });
        await transferred.getByTestId("signed-originals-input").setInputFiles({ ...imported, buffer: Buffer.from(zipSync({ ...archive, "public-key.pem": await readFile(privatePath) }, { level: 0 })) });
        await expect(transferred.getByRole("alert")).toContainText("Private keys are not accepted");
        expect(keyRequests).toBe(0);
        await expect(transferred.getByRole("status", { name: "Signature verification" })).toHaveCount(0);
        await expect(transferred.getByRole("button", { name: "Download signed originals", exact: true })).toBeDisabled();
        await transferred.getByTestId("signed-originals-input").setInputFiles(imported);
        await expect(transferred.getByRole("status", { name: "Signed archive import" })).toBeVisible();
        await expect(transferred.getByRole("status", { name: "Signature verification" })).toHaveCount(0);
        await transferred.getByRole("button", { name: "Public keys", exact: true }).click();
        await expect(transferred.getByRole("dialog").locator("tbody tr")).toHaveCount(1);
        await transferred.getByRole("button", { name: "Revoke local trust", exact: true }).click();
        await transferred.getByRole("button", { name: "Close public keys", exact: true }).click();
        await transferred.getByTestId("signed-originals-input").setInputFiles(imported);
        await expect(transferred.getByRole("status", { name: "Signed archive import" })).toBeVisible();
        await expect(transferred.getByRole("button", { name: "Verify signature", exact: true })).toBeDisabled();
        await expect(transferred.getByRole("status", { name: "Signature verification" })).toHaveCount(0);
        expect(await transferred.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await transferred.screenshot({ path: testInfo.outputPath(`signed-archive-${width}.png`), fullPage: true });
      } finally { await recipient.close(); }
      const second = await context.newPage();
      await second.goto(reportURL);
      await second.getByRole("button", { name: "Public keys", exact: true }).click();
      await expect(second.getByRole("row", { name: /Lab operator/ })).toContainText("Trusted locally");
      await second.getByRole("button", { name: "Revoke local trust", exact: true }).click();
      await expect(page.getByRole("status", { name: "Signature verification" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Download signed originals", exact: true })).toBeDisabled();
      await second.close();
      await page.getByRole("button", { name: "Public keys", exact: true }).click();
      await page.getByRole("button", { name: "Trust public key", exact: true }).click();
      await page.getByRole("checkbox", { name: /I verified this fingerprint/ }).check();
      await page.getByRole("button", { name: "Confirm trust", exact: true }).click();
      await page.getByRole("button", { name: "Close public keys", exact: true }).click();
      await page.getByTestId("evidence-input").setInputFiles({ name: "edited.run.json", mimeType: "application/json", buffer: Buffer.concat([evidence, Buffer.from("\n")]) });
      await page.getByTestId("attestation-input").setInputFiles({ name: "run.attestation.json", mimeType: "application/json", buffer: sidecar });
      await page.getByRole("button", { name: "Verify signature", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("digest does not match");
      await expect(page.getByRole("status", { name: "Signature verification" })).toHaveCount(0);
      await page.reload();
      await page.getByRole("button", { name: "Public keys", exact: true }).click();
      await expect(page.getByRole("row", { name: /Lab operator/ })).toContainText("Trusted locally");
      const privateKey = await readFile(privatePath);
      let privateRequests = 0;
      page.on("request", outgoing => { if (outgoing.postData()?.includes("BEGIN PRIVATE KEY")) privateRequests++; });
      await page.getByTestId("public-key-input").setInputFiles({ name: "private.pem", mimeType: "application/x-pem-file", buffer: privateKey });
      await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Private keys are not accepted");
      expect(privateRequests).toBe(0);
      await expect(page.getByRole("row", { name: /Lab operator/ })).toHaveCount(1);
      await page.getByRole("button", { name: "Delete public key", exact: true }).click();
      await page.getByRole("button", { name: "Delete key", exact: true }).click();
      await expect(page.getByRole("row", { name: /Lab operator/ })).toHaveCount(0);
      await page.getByRole("button", { name: "Close public keys", exact: true }).click();
      await page.goto(reportURL.replace("/report", "/runs"));
      await expect(page.locator(".runs-table tbody tr")).toHaveCount(1);
      await expect(page.locator(".saved-runs")).toContainText("Attestation attached");
      await page.locator(".saved-runs .run-name").click();
      await expect(page.getByRole("button", { name: "Replace attestation", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Verify signature", exact: true })).toBeDisabled();
      await expect(page.getByRole("status", { name: "Signature verification" })).toHaveCount(0);
      await page.getByRole("button", { name: "Remove attestation", exact: true }).click();
      await expect(page.getByRole("button", { name: "Attach attestation", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Save run", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Save run", exact: true }).click();
      await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeDisabled();
      await page.goto(reportURL.replace("/report", "/runs"));
      await expect(page.locator(".saved-runs tbody")).not.toContainText("Attestation attached");
      await page.locator(".saved-runs .run-name").click();
      await expect(page.getByRole("button", { name: "Attach attestation", exact: true })).toBeVisible();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test(`suite history preserves originals and re-evaluates saved snapshots at ${width}px`, async ({ page }, testInfo) => {
    const files = await suiteBundle();
    await page.setViewportSize({ width, height: 900 });
    await page.goto(process.env.NOSTEKON_APP_URL ? "/#/suite" : "/demo/#/suite");
    await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toContainText("Evidence matches the summary");
    await page.getByRole("button", { name: "Save suite", exact: true }).click();
    await expect(page.getByRole("status", { name: "Suite snapshot save result" })).toContainText("Suite saved");
    await page.getByRole("button", { name: "Save suite", exact: true }).click();
    await page.getByRole("tab", { name: "Saved suites", exact: true }).click();
    await expect(page.getByRole("row", { name: /PostgreSQL policy suite/ })).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const name of [/Reopen suite/, /Download original suite files/, /Delete suite/]) {
      const bounds = await page.getByRole("button", { name }).boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
    await page.screenshot({ path: testInfo.outputPath(`suite-library-${width}.png`), fullPage: true });
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: /Download original suite files/ }).click();
    const archive = await download;
    expect(archive.suggestedFilename()).toMatch(/^nostekon-suite-[a-f0-9]+-originals\.zip$/);
    const originals = unzipSync(await readFile((await archive.path())!));
    expect(Object.keys(originals).sort()).toEqual(files.map(file => file.name).sort());
    for (const file of files) expect(Buffer.from(originals[file.name])).toEqual(file.buffer);
    await page.reload();
    await page.getByRole("tab", { name: "Saved suites", exact: true }).click();
    await expect(page.getByRole("row", { name: /PostgreSQL policy suite/ })).toHaveCount(1);
    await page.getByRole("button", { name: /Reopen suite/ }).click();
    await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toContainText("Imported evidence");
    await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toContainText("Evidence matches the summary");
    await page.getByRole("button", { name: "Save cases", exact: true }).click();
    await expect(page.getByRole("status", { name: "Suite save result" })).toContainText("3 cases saved");
    await page.getByRole("tab", { name: "Saved suites", exact: true }).click();
    await page.getByRole("button", { name: /Delete suite/ }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("row", { name: /PostgreSQL policy suite/ })).toHaveCount(1);
    await page.getByRole("button", { name: /Delete suite/ }).click();
    await page.getByRole("button", { name: "Delete suite", exact: true }).click();
    await expect(page.getByText("No saved suites yet", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Runs", exact: true }).click();
    await expect(page.getByRole("region", { name: "Saved run totals" })).toContainText("3");
    await page.getByRole("link", { name: "Suite", exact: true }).click();
    await page.getByRole("tab", { name: "Review", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`suite-history-${width}.png`), fullPage: true });
  });

  test(`app information exposes actual engine and storage origin at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(process.env.NOSTEKON_APP_URL ? "/#/runs" : "/demo/#/runs");
    await page.getByRole("button", { name: "About Nostekon", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "About Nostekon" });
    await expect(dialog).toContainText(process.env.NOSTEKON_APP_URL ? "Local Go API" : "Go in this browser");
    await expect(dialog).toContainText("Lab execution");
    await expect(dialog).toContainText("Disabled");
    await expect(dialog).toContainText(new URL(page.url()).origin);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`about-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "Close app information" }).click();
    await expect(dialog).not.toBeVisible();
  });

  test(`real backup rehearsal preserves limited scope and exact originals at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(process.env.NOSTEKON_APP_URL ? "/#/report" : "/demo/#/report");
    await page.getByRole("button", { name: /^PostgreSQL backup rehearsal/ }).click();
    await expect(page.getByRole("status", { name: "Backup rehearsal scope" })).toContainText("not incident RTO");
    await expect(page.locator(".sample-caveat")).toContainText("disposable local PostgreSQL restore");
    await expect(page.locator(".sample-caveat")).not.toContainText("two-cluster");
    await page.goto(process.env.NOSTEKON_APP_URL ? "/#/runs" : "/demo/#/runs");
    const original = await readFile(new URL("./postgresql-plan-rehearsal.run.json", import.meta.url));
    await page.getByTestId("run-evidence-input").setInputFiles({ name: "backup-rehearsal.json", mimeType: "application/json", buffer: original });
    await expect(page.getByRole("heading", { name: "Verified to V3" })).toBeVisible();
    await expect(page.getByRole("status", { name: "Backup rehearsal scope" })).toContainText("not incident RTO");
    await expect(page.locator(".metric-label", { hasText: "Rehearsal duration" })).toBeVisible();
    await expect(page.locator(".metric-sub", { hasText: "no write ledger" })).toBeVisible();
    await expect(page.getByRole("status", { name: "Evidence provenance" })).toContainText("unverified");
    const markdownDownload = page.waitForEvent("download");
    await page.getByTitle("Download the evidence summary as Markdown", { exact: true }).click();
    const markdown = await readFile((await (await markdownDownload).path())!, "utf8");
    expect(markdown).toContain("Rehearsal duration:");
    expect(markdown).toContain("Restore plan binding");
    expect(markdown).toContain("not operator approval");
    expect(markdown).not.toContain("Failure injected:");
    await page.getByRole("button", { name: "Save run", exact: true }).click();
    await page.getByRole("link", { name: "Runs", exact: true }).click();
    const name = JSON.parse(original.toString()).metadata.name as string;
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(1);
    const originalDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: `Download evidence for ${name}`, exact: true }).click();
    expect(await readFile((await (await originalDownload).path())!)).toEqual(original);
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("status", { name: "Backup rehearsal scope" })).toBeVisible();
    await page.getByRole("button", { name: /^V0/ }).click();
    await expect(page.getByText("Restore plan binding", { exact: true })).toBeVisible();
    const binding = page.getByText(/^Canonical plan SHA-256/);
    await expect(binding).toContainText("not operator approval or authenticated provenance");
    expect(await binding.evaluate(detail => detail.scrollWidth <= detail.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`backup-rehearsal-${width}.png`), fullPage: true });
  });

  test(`real semantic backup checks expose corruption despite matching counts at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(process.env.NOSTEKON_APP_URL ? "/#/runs" : "/demo/#/runs");
    const original = await readFile(new URL("./postgresql-semantic-rehearsal.run.json", import.meta.url));
    await page.getByTestId("run-evidence-input").setInputFiles({ name: "semantic-rehearsal.json", mimeType: "application/json", buffer: original });
    await expect(page.getByRole("heading", { name: /^Failed at V4/ })).toBeVisible();
    await expect(page.getByRole("status", { name: "Backup rehearsal scope" })).toContainText("not incident RTO");
    await expect(page.locator(".metric-sub", { hasText: "no write ledger" })).toBeVisible();
    await expect(page.getByRole("status", { name: "Evidence provenance" })).toContainText("unverified");
    const recorded = JSON.parse(original.toString());
    const checks = recorded.status.checks.filter((check: { level: string }) => check.level === "V4");
    for (const check of checks) {
      const detail = page.getByText(check.detail, { exact: true });
      await expect(detail).toBeVisible();
      expect(await detail.evaluate(element => getComputedStyle(element).whiteSpace)).toBe("normal");
      expect(await detail.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    const markdownDownload = page.waitForEvent("download");
    await page.getByTitle("Download the evidence summary as Markdown", { exact: true }).click();
    const markdown = await readFile((await (await markdownDownload).path())!, "utf8");
    expect(markdown).toContain("## Reported V4 Checks");
    for (const check of checks) expect(markdown).toContain(`| ${check.name} | FAIL | ${check.detail} |`);
    await page.getByRole("button", { name: /^V3/ }).click();
    await expect(page.getByText("expected 3; measured 3", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^V4/ }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`semantic-rehearsal-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "Save run", exact: true }).click();
    await page.getByRole("link", { name: "Runs", exact: true }).click();
    const originalDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: `Download evidence for ${recorded.metadata.name}`, exact: true }).click();
    expect(await readFile((await (await originalDownload).path())!)).toEqual(original);
  });

  test(`download page distinguishes real local artifacts from unpublished releases at ${width}px`, async ({ page }, testInfo) => {
    test.skip(!!process.env.NOSTEKON_APP_URL, "product route belongs to the static site");
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/download/");
    await expect(page.getByRole("heading", { name: "Download Nostekon" })).toBeVisible();
    await expect(page.locator(".flow-track")).toContainText("./start-nostekon.sh");
    await expect(page.locator(".flow-track")).toContainText("Start-Nostekon.cmd");
    await expect(page.getByRole("main")).toContainText("A renamed tag release has not been published");
    await expect(page.getByRole("link", { name: "Installation guide", exact: true })).toHaveAttribute("href", "/docs/guides/portable-app/");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (await page.locator(".all-builds").count()) await page.getByText("All platform builds", { exact: true }).click();
    for (const link of await page.locator(".download-build a").all()) {
      const bounds = await link.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      const response = await page.request.head((await link.getAttribute("href"))!);
      expect(response.ok()).toBe(true);
      expect(response.headers()["content-encoding"] ?? "identity").toBe("identity");
      const download = page.waitForEvent("download");
      await link.click();
      const downloaded = await download;
      expect(await downloaded.failure()).toBeNull();
      const original = await readFile((await downloaded.path())!);
      expect(createHash("sha256").update(original).digest("hex")).toBe(await link.getAttribute("data-sha256"));
    }
    const reportImage = page.getByRole("img", { name: /^Nostekon Studio evaluating/ });
    await reportImage.scrollIntoViewIfNeeded();
    await expect(reportImage).toHaveJSProperty("complete", true);
    expect(await reportImage.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`downloads-${width}.png`), fullPage: true });
  });

  test(`run backup restores exact originals without cached verdicts or trust at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const reportURL = process.env.NOSTEKON_APP_URL ? "/#/report" : "/demo/#/report";
    const evidence = await readFile(new URL("../../examples/runs/k3d-ledger-tail-loss.run.json", import.meta.url));
    const sidecar = Buffer.from('{ "signature": "unverified original" }\n');
    await page.goto(reportURL);
    await page.getByTestId("evidence-input").setInputFiles({ name: "original.json", mimeType: "application/json", buffer: evidence });
    await expect(page.locator(".verdict.failed")).toBeVisible();
    await page.getByTestId("attestation-input").setInputFiles({ name: "sidecar.json", mimeType: "application/json", buffer: sidecar });
    await expect(page.getByRole("button", { name: "Save run", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Save run", exact: true }).click();
    await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeDisabled();
    await page.goto(reportURL.replace("/report", "/runs"));
    const download = page.waitForEvent("download");
    for (const name of ["Back up saved runs", "Restore run backup"]) {
      const bounds = await page.getByRole("button", { name, exact: true }).boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }
    await page.getByRole("button", { name: "Back up saved runs", exact: true }).click();
    const backup = await readFile((await (await download).path())!);
    const contents = JSON.parse(backup.toString());
    expect(contents.runs[0].evidence).toBe(evidence.toString());
    expect(contents.runs[0].attestation).toBe(sidecar.toString());
    expect(contents.runs[0].report).toBeUndefined();
    expect(contents.trustedKeys).toBeUndefined();
    const recipient = await page.context().browser()!.newContext();
    try {
      const restored = await recipient.newPage();
      await restored.setViewportSize({ width, height: 900 });
      await restored.goto(new URL(reportURL.replace("/report", "/runs"), page.url()).href);
      const input = restored.getByTestId("run-backup-input");
      await input.setInputFiles({ name: "backup.json", mimeType: "application/json", buffer: backup });
      await expect(restored.getByRole("dialog", { name: "Restore 1 saved runs?" })).toBeVisible();
      await expect(restored.locator(".runs-table tbody tr")).toHaveCount(0);
      await restored.getByRole("button", { name: "Confirm restore", exact: true }).click();
      await expect(restored.getByRole("status", { name: "Run backup restore result" })).toContainText("1 run restored");
      await expect(restored.locator(".saved-runs")).toContainText("failed");
      await expect(restored.locator(".saved-runs")).toContainText("Imported evidence");
      await expect(restored.locator(".saved-runs")).toContainText("Attestation attached");
      const invalidEvidence = '{"kind":"DrillRun","apiVersion":"unknown"}';
      const failedBatch = { ...contents, runs: [contents.runs[0], { evidence: invalidEvidence, sha256: createHash("sha256").update(invalidEvidence).digest("hex") }] };
      await input.setInputFiles({ name: "invalid-case.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(failedBatch)) });
      await restored.getByRole("button", { name: "Confirm restore", exact: true }).click();
      await expect(restored.getByRole("alert")).toContainText("no runs were restored");
      await expect(restored.locator(".runs-table tbody tr")).toHaveCount(1);
      await restored.evaluate(() => {
        const originalPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (value, key) {
          if (this.name === "runs") throw new DOMException("Backup quota full", "QuotaExceededError");
          return originalPut.call(this, value, key);
        };
      });
      await input.setInputFiles({ name: "retry.json", mimeType: "application/json", buffer: backup });
      await restored.getByRole("button", { name: "Confirm restore", exact: true }).click();
      await expect(restored.getByRole("alert")).toContainText("Backup quota full");
      await expect(restored.locator(".runs-table tbody tr")).toHaveCount(1);
      await restored.reload();
      await expect(restored.locator(".runs-table tbody tr")).toHaveCount(1);
      const broken = { ...contents, runs: [{ ...contents.runs[0], evidence: evidence.toString() + "\n" }] };
      await input.setInputFiles({ name: "tampered.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(broken)) });
      await expect(restored.getByRole("alert")).toContainText("integrity");
      await expect(restored.locator(".runs-table tbody tr")).toHaveCount(1);
      await restored.screenshot({ path: testInfo.outputPath(`restored-backup-${width}.png`), fullPage: true });
      await restored.locator(".saved-runs .run-name").click();
      await expect(restored.locator(".verdict.failed")).toBeVisible();
      await expect(restored.getByRole("button", { name: "Replace attestation", exact: true })).toBeVisible();
      await expect(restored.getByRole("status", { name: "Signature verification" })).toHaveCount(0);
      await restored.getByRole("button", { name: "Public keys", exact: true }).click();
      await expect(restored.getByRole("dialog")).toContainText("No public keys");
    } finally { await recipient.close(); }
  });

  test(`suite history keeps partial captures failed and rejects damaged snapshots at ${width}px`, async ({ page }) => {
    const files = await suiteBundle();
    const summary = JSON.parse(files[0].buffer.toString());
    summary.status = "interrupted"; summary.passed = false; summary.cases = summary.cases.slice(0, 1);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(process.env.NOSTEKON_APP_URL ? "/#/suite" : "/demo/#/suite");
    await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toBeVisible();
    await page.getByTestId("suite-input").setInputFiles([{ ...files[0], buffer: Buffer.from(JSON.stringify(summary)) }, files[1]]);
    const gate = page.getByRole("region", { name: "Suite review totals" }).locator("div").filter({ has: page.getByText("Suite gate", { exact: true }) });
    await expect(gate).toContainText("failed");
    await page.getByRole("button", { name: "Save suite", exact: true }).click();
    await expect(page.getByRole("status", { name: "Suite snapshot save result" })).toBeVisible();
    await page.getByRole("tab", { name: "Review", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Saved suites", exact: true })).toBeFocused();
    await expect(page.getByRole("row", { name: /PostgreSQL policy suite/ })).toContainText("interrupted");
    await page.getByRole("button", { name: /Reopen suite/ }).click();
    await expect(gate).toContainText("failed");
    await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toContainText("Imported evidence");
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("nostekon-runs", 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction("suites", "readwrite");
        const saved = transaction.objectStore("suites").getAll();
        saved.onsuccess = () => {
          const suite = saved.result[0];
          suite.files[1].source = "tampered";
          transaction.objectStore("suites").put(suite);
        };
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
    }));
    await page.getByRole("tab", { name: "Saved suites", exact: true }).click();
    await page.getByRole("button", { name: /Reopen suite/ }).click();
    await expect(page.getByRole("alert")).toContainText("integrity check failed");
    await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save suite", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Export review", exact: true })).toBeDisabled();
    await page.getByRole("tab", { name: "Saved suites", exact: true }).click();
    await expect(page.getByRole("row", { name: /PostgreSQL policy suite/ })).toHaveCount(1);
  });

  test(`suite review gate matches the Go CLI and fails partial evidence at ${width}px`, async ({ page }, testInfo) => {
    const expected = JSON.parse(execFileSync("go", ["run", "./cmd/nostekon-report", "--suite", "examples/suites/postgresql-policy"], { cwd: new URL("../../", import.meta.url), encoding: "utf8" }));
    await page.setViewportSize({ width, height: 900 });
    await page.goto(process.env.NOSTEKON_APP_URL ? "/#/suite" : "/demo/#/suite");
    await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toContainText("Evidence matches the summary");
    const gate = page.getByRole("region", { name: "Suite review totals" }).locator("div").filter({ has: page.getByText("Suite gate", { exact: true }) });
    await expect(gate).toContainText("passed");
    let download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export review", exact: true }).click();
    let exported = await download;
    expect(exported.suggestedFilename()).toBe("suite-review.json");
    expect(JSON.parse(await readFile((await exported.path())!, "utf8"))).toEqual(expected);
    const files = await suiteBundle();
    const partial = JSON.parse(files[0].buffer.toString());
    partial.status = "interrupted"; partial.passed = false; partial.cases = partial.cases.slice(0, 1);
    await page.getByTestId("suite-input").setInputFiles([{ ...files[0], buffer: Buffer.from(JSON.stringify(partial)) }, files[1]]);
    await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toContainText("Evidence matches the summary");
    await expect(gate).toContainText("failed");
    download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export review", exact: true }).click();
    exported = await download;
    expect(JSON.parse(await readFile((await exported.path())!, "utf8"))).toMatchObject({ passed: false, complete: false, evidenceMatches: true, runnerStatus: "interrupted" });
    await page.getByTestId("suite-input").setInputFiles([{ ...files[0], buffer: Buffer.from("invalid") }]);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("button", { name: "Export review", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Recorded suite", exact: true }).click();
    await expect(gate).toContainText("passed");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`suite-review-${width}.png`), fullPage: true });
  });

  test(`portable evidence bundle rejects corruption without stale success at ${width}px`, async ({ page }, testInfo) => {
    const archive = evidenceArchive(await suiteBundle());
    const changed = unzipSync(archive);
    changed["zero-loss.drillrun.json"][0] ^= 1;
    const corrupted = zipSync(changed, { level: 0 });
    let evaluations = 0;
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/v1/runs/report") evaluations++; });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(process.env.NOSTEKON_APP_URL ? "/#/suite" : "/demo/#/suite");
    await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toContainText("Recorded local lab");
    const before = evaluations;
    await page.getByTestId("suite-bundle-input").setInputFiles({ name: "corrupted.zip", mimeType: "application/zip", buffer: Buffer.from(corrupted) });
    await expect(page.getByRole("alert")).toContainText("checksum mismatch");
    await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save cases", exact: true })).toBeDisabled();
    expect(evaluations).toBe(before);
    await page.getByTestId("suite-bundle-input").setInputFiles({ name: "valid.zip", mimeType: "application/zip", buffer: Buffer.from(archive) });
    await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toContainText("Evidence matches the summary");
    await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toContainText("Imported evidence");
    await expect(page.getByRole("button", { name: "Save cases", exact: true })).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`bundle-import-${width}.png`), fullPage: true });
  });
}

test("installed app keeps lab execution disabled by default", async ({ page }) => {
  test.skip(!process.env.NOSTEKON_APP_URL, "Requires the packaged app.");
  await page.goto("/#/lab");
  await expect(page.getByRole("link", { name: "Lab", exact: true })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Lab jobs" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Lab availability" })).toContainText("Execution disabled");
  await expect(page.getByRole("button", { name: "Run suite", exact: true })).toBeDisabled();
});

for (const width of [390, 1440]) {
  test(`installed app lab job progresses into independently reviewed evidence at ${width}px`, async ({ page }, testInfo) => {
    test.skip(!process.env.NOSTEKON_APP_URL, "Requires the packaged app.");
    const files = await suiteBundle();
    const archive = evidenceArchive(files);
    const summary = JSON.parse(files[0].buffer.toString());
    const identifier = "a".repeat(24);
    const errors: string[] = [];
    const starts: unknown[] = [];
    let started = false;
    let completed = false;
    const snapshot = () => ({
      id: identifier, status: completed ? "completed" : "running", options: { writes: 10, rpoSeconds: 60 },
      startedAt: "2026-10-07T10:00:00Z", ...(completed ? { completedAt: "2026-10-07T10:01:00Z", exitCode: 0 } : {}),
      log: completed ? "Suite finished.\n" : "Suite started.\n", logTruncated: false,
      artifacts: completed ? files.map(file => file.name) : ["suite.json"],
      summary: completed ? summary : { ...summary, status: "running", passed: false, cases: [] },
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/v1/lab**", async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      expect(request.headers()["x-nostekon-lab"]).toBe("true");
      if (path.endsWith("/export")) {
        await route.fulfill({ contentType: "application/zip", body: Buffer.from(archive) });
      } else if (path.includes("/artifacts/")) {
        const file = files.find(file => path.endsWith(`/artifacts/${file.name}`));
        expect(file).toBeDefined();
        await route.fulfill({ status: 200, contentType: "application/json", body: file!.buffer });
      } else if (path === "/api/v1/lab/jobs" && request.method() === "POST") {
        starts.push(request.postDataJSON()); started = true;
        await route.fulfill({ status: 202, json: snapshot() });
      } else if (path === "/api/v1/lab/jobs") {
        await route.fulfill({ json: started ? [snapshot()] : [] });
      } else if (path.endsWith(identifier)) {
        await route.fulfill({ json: snapshot() });
      } else {
        await route.fulfill({ json: { enabled: true } });
      }
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#/lab");
    await expect(page.getByRole("status", { name: "Lab availability" })).toContainText("Local execution enabled");
    await page.getByLabel("Writes per case").fill("99");
    await page.getByRole("button", { name: "Run suite", exact: true }).click();
    expect(starts).toEqual([]);
    await page.getByLabel("Writes per case").fill("10");
    await page.getByRole("button", { name: "Run suite", exact: true }).click();
    await expect(page.getByRole("status", { name: "Lab job status" })).toContainText("running");
    await expect(page.getByRole("button", { name: "Export bundle", exact: true })).toBeDisabled();
    expect(starts).toEqual([{ writes: 10, rpoSeconds: 60 }]);
    await expect(page.getByRole("button", { name: "Run suite", exact: true })).toBeDisabled();
    completed = true;
    await expect(page.getByRole("status", { name: "Lab job status" })).toContainText("completed");
    await expect(page.getByRole("progressbar", { name: "Completed policy cases" })).toHaveAttribute("value", "3");
    const bundleDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export bundle", exact: true }).click();
    const downloadedBundle = await bundleDownload;
    expect(downloadedBundle.suggestedFilename()).toBe(`nostekon-lab-${identifier}.zip`);
    const bundlePath = (await downloadedBundle.path())!;
    expect(await readFile(bundlePath)).toEqual(Buffer.from(archive));
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "suite.json", exact: true }).click();
    expect(await readFile((await (await download).path())!)).toEqual(files[0].buffer);
    if (width === 390) {
      const table = page.getByRole("region", { name: "Lab jobs table" });
      await table.focus();
      expect(await table.evaluate(element => { element.scrollLeft = element.scrollWidth; return element.scrollLeft > 0; })).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`lab-completed-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "Review suite", exact: true }).click();
    await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toContainText("Evidence matches the summary");
    await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toContainText("Imported evidence");
    await page.getByTestId("suite-bundle-input").setInputFiles({ name: "exported.zip", mimeType: "application/zip", buffer: await readFile(bundlePath) });
    await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toContainText("Evidence matches the summary");
    await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toContainText("Imported evidence");
    await page.getByRole("button", { name: "Save cases", exact: true }).click();
    await expect(page.getByRole("status", { name: "Suite save result" })).toContainText("3 cases saved to Runs");
    await page.getByRole("link", { name: "Runs", exact: true }).click();
    await page.reload();
    await expect(page.locator(".saved-runs tbody tr")).toHaveCount(3);
    expect(errors).toEqual([]);
  });
}

test("installed app restart recovery blocks execution until explicit cleanup confirmation", async ({ page }) => {
  test.skip(!process.env.NOSTEKON_APP_URL, "Requires the packaged app.");
  const identifier = "c".repeat(24);
  let confirmed = false;
  const snapshot = () => ({
    id: identifier, status: "interrupted", recoveryRequired: !confirmed,
    options: { writes: 10, rpoSeconds: 60 }, startedAt: "2026-10-07T10:00:00Z", completedAt: "2026-10-07T10:01:00Z",
    log: "Saved before restart.", logTruncated: false, artifacts: [],
  });
  await page.route("**/api/v1/lab**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/acknowledge-recovery")) {
      expect(route.request().postDataJSON()).toEqual({ cleanupConfirmed: true });
      expect(route.request().headers()["x-nostekon-lab"]).toBe("true");
      confirmed = true; await route.fulfill({ json: snapshot() });
    } else if (path === "/api/v1/lab/jobs") await route.fulfill({ json: [snapshot()] });
    else if (path.endsWith(identifier)) await route.fulfill({ json: snapshot() });
    else await route.fulfill({ json: { enabled: true } });
  });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/#/lab");
  await expect(page.getByRole("status", { name: "Lab job status" })).toContainText("interrupted");
  await expect(page.getByRole("button", { name: "Run suite", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Confirm cleanup", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Export bundle", exact: true })).toBeDisabled();
  await page.getByRole("checkbox", { name: "Old runner processes stopped and lab namespaces checked" }).check();
  await page.getByRole("button", { name: "Confirm cleanup", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run suite", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Export bundle", exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole("status", { name: "Lab job status" })).toContainText("interrupted");
  await expect(page.getByRole("button", { name: "Run suite", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("installed app lab cancellation retains an interrupted summary", async ({ page }) => {
  test.skip(!process.env.NOSTEKON_APP_URL, "Requires the packaged app.");
  const files = await suiteBundle();
  const summary = JSON.parse(files[0].buffer.toString());
  const identifier = "b".repeat(24);
  let cancelled = false;
  const snapshot = () => ({
    id: identifier, status: cancelled ? "cancelled" : "running", options: { writes: 10, rpoSeconds: 60 },
    startedAt: "2026-10-07T10:00:00Z", ...(cancelled ? { completedAt: "2026-10-07T10:01:00Z", exitCode: 130 } : {}),
    log: "", logTruncated: false, artifacts: ["suite.json"],
    summary: cancelled ? { ...summary, status: "interrupted", passed: false, cases: [] } : { invalid: "checkpoint" },
  });
  await page.route("**/api/v1/lab**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/cancel")) { cancelled = true; await route.fulfill({ status: 202, json: { status: "cancellation requested" } }); }
    else if (path === "/api/v1/lab/jobs") await route.fulfill({ json: [snapshot()] });
    else if (path.endsWith(identifier)) await route.fulfill({ json: snapshot() });
    else await route.fulfill({ json: { enabled: true } });
  });
  await page.goto("/#/lab");
  await expect(page.getByRole("status", { name: "Lab job status" })).toContainText("running");
  await expect(page.getByRole("alert")).toContainText("Could not read checkpoint");
  await page.getByRole("button", { name: "Cancel job", exact: true }).click();
  await expect(page.getByRole("status", { name: "Lab job status" })).toContainText("cancelled");
  await expect(page.getByRole("status", { name: "Lab job status" })).toContainText("exit 130");
  await expect(page.getByRole("button", { name: "Review suite", exact: true })).toBeEnabled();
});

for (const width of [390, 1440]) {
  test(`installed app evaluates and saves evidence through the API at ${width}px`, async ({ page }, testInfo) => {
    test.skip(!process.env.NOSTEKON_APP_URL, "Requires the packaged app; static demo checks run separately.");
    const errors: string[] = [];
    const files = await suiteBundle();
    const reportStatuses = new Map<string, number>();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (new URL(response.url()).pathname === "/api/v1/runs/report") {
        reportStatuses.set(response.request().postDataJSON().metadata.name, response.status());
      }
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#/suite");
    await expect(page.locator(".api-status")).toContainText("API connected");
    await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toContainText("Evidence matches the summary");
    await expect(page.locator(".suite-table tbody tr > td:nth-child(2)")).toHaveText(["verified", "failed", "verified"]);
    expect(files.slice(1).map(file => reportStatuses.get(JSON.parse(file.buffer.toString()).metadata.name))).toEqual([200, 200, 200]);
    await page.getByRole("button", { name: "Save cases", exact: true }).click();
    await expect(page.getByRole("status", { name: "Suite save result" })).toContainText("3 cases saved to Runs");
    await page.getByRole("link", { name: "Runs", exact: true }).click();
    await page.reload();
    await expect(page.locator(".saved-runs tbody tr")).toHaveCount(3);
    await page.getByRole("button", { name: JSON.parse(files[2].buffer.toString()).metadata.name, exact: true }).click();
    await expect(page.getByRole("heading", { name: "Failed at V4" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`installed-app-${width}.png`), fullPage: true });
    expect(errors).toEqual([]);
  });
}

for (const width of [390, 1440]) {
  test(`recorded suite reviews all policy outcomes at ${width}px`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/demo/#/suite");
    await expect(page.getByRole("heading", { name: "Policy suite" })).toBeVisible();
    const agreement = page.getByRole("status", { name: "Suite evidence agreement" });
    await expect(agreement).toContainText("Evidence matches the summary");
    await expect(agreement).toContainText("Recorded local lab");
    await expect(agreement).toContainText("signatures unverified");
    const rows = page.locator(".suite-table tbody tr");
    await expect(rows).toHaveCount(3);
    for (const [index, verdict, lost, budget] of [[0, "verified", "0", "0s"], [1, "failed", "2", "0s"], [2, "verified", "2", "1m"]] as const) {
      await expect(rows.nth(index).locator("td").nth(1)).toHaveText(verdict);
      await expect(rows.nth(index).locator("td").nth(2)).toHaveText("10");
      await expect(rows.nth(index).locator("td").nth(3)).toHaveText(lost);
      await expect(rows.nth(index).locator("td").nth(5)).toHaveText(budget);
      await expect(rows.nth(index).locator("td").nth(7)).toHaveText("Matches");
    }
    await page.getByRole("button", { name: "Save cases", exact: true }).click();
    await expect(page.getByRole("status", { name: "Suite save result" })).toContainText("3 cases saved to Runs");
    for (const theme of ["dark", "light"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("[data-theme-toggle]").click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 390) expect(await page.locator(".suite-workspace .table-scroll").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`suite-${width}-${theme}.png`), fullPage: true });
    }
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download original suite summary" }).click();
    expect(await readFile((await (await download).path())!)).toEqual((await suiteBundle())[0].buffer);
    await page.getByRole("button", { name: "Open Strict tail loss report" }).click();
    await expect(page.getByRole("heading", { name: "Failed at V4" })).toBeVisible();
    await page.getByRole("link", { name: "Suite", exact: true }).click();
    await expect(agreement).toContainText("Evidence matches the summary");
    expect(errors).toEqual([]);
  });
}

test("suite imports expose changed claims and preserve original evidence", async ({ page }) => {
  await page.goto("/demo/#/suite");
  await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toContainText("Evidence matches");
  const files = await suiteBundle();
  const summary = JSON.parse(files[0].buffer.toString());
  summary.cases[2].rpo.lost = 0;
  files[0].buffer = Buffer.from(JSON.stringify(summary));
  await page.locator('[data-testid="suite-input"]').setInputFiles(files);
  const agreement = page.getByRole("status", { name: "Suite evidence agreement" });
  await expect(agreement).toContainText("Evidence needs attention");
  await expect(agreement).toContainText("Imported evidence");
  await expect(page.getByRole("region", { name: "Suite findings" })).toContainText("lost differs from the suite summary.");
  await expect(page.locator(".suite-table tbody tr").nth(2)).toContainText("Mismatch");
  const summaryDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download original suite summary" }).click();
  expect(await readFile((await (await summaryDownload).path())!)).toEqual(files[0].buffer);
  await page.getByRole("button", { name: "Open Budgeted tail loss report" }).click();
  await expect(page.getByRole("heading", { name: "Verified to V4" })).toBeVisible();
  const evidenceDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download original evidence" }).click();
  expect(await readFile((await (await evidenceDownload).path())!)).toEqual(files[3].buffer);
});

test("suite cases save together, survive reload and deduplicate without adding provenance", async ({ page }) => {
  await page.goto("/demo/#/suite");
  await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toContainText("Evidence matches");
  const files = await suiteBundle();
  await page.locator('[data-testid="suite-input"]').setInputFiles(files);
  await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toContainText("Imported evidence");
  await page.getByRole("button", { name: "Save cases", exact: true }).click();
  await expect(page.getByRole("status", { name: "Suite save result" })).toContainText("3 cases saved to Runs");
  await page.getByRole("button", { name: "Save cases", exact: true }).click();
  await expect(page.getByRole("status", { name: "Suite save result" })).toContainText("3 cases saved to Runs");
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await page.reload();
  const rows = page.locator(".saved-runs tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.locator(".evidence-kind")).toHaveText(["Imported evidence", "Imported evidence", "Imported evidence"]);
  for (const [index, verdict] of [[1, "verified"], [2, "failed"], [3, "verified"]] as const) {
    const name = JSON.parse(files[index].buffer.toString()).metadata.name;
    await expect(rows.filter({ has: page.getByRole("button", { name, exact: true }) }).locator(".verdict-tag")).toHaveText(verdict);
  }
  await page.getByRole("button", { name: JSON.parse(files[2].buffer.toString()).metadata.name, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Failed at V4" })).toBeVisible();
  const evidenceDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download original evidence" }).click();
  expect(await readFile((await (await evidenceDownload).path())!)).toEqual(files[2].buffer);
  await page.getByRole("link", { name: "Suite", exact: true }).click();
  await page.getByRole("button", { name: "Recorded suite", exact: true }).click();
  await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toContainText("Recorded local lab");
  await expect(page.getByRole("status", { name: "Suite save result" })).toHaveCount(0);
});

test("suite storage failures leave no partial cases or stale save success and can be retried", async ({ page }) => {
  await page.goto("/demo/#/suite");
  await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toContainText("Evidence matches");
  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put;
    let writes = 0;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === "runs" && ++writes === 2) {
        IDBObjectStore.prototype.put = originalPut;
        throw new DOMException("Storage full", "QuotaExceededError");
      }
      return originalPut.call(this, value, key);
    };
  });
  await page.getByRole("button", { name: "Save cases", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Storage full");
  await expect(page.getByRole("status", { name: "Suite save result" })).toHaveCount(0);
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No saved runs yet" })).toBeVisible();
  await page.getByRole("link", { name: "Suite", exact: true }).click();
  await page.getByRole("button", { name: "Save cases", exact: true }).click();
  await expect(page.getByRole("status", { name: "Suite save result" })).toContainText("3 cases saved to Runs");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await expect(page.locator(".saved-runs tbody tr")).toHaveCount(3);
});

test("missing and invalid suite files cannot leave a previous matching review visible", async ({ page }) => {
  await page.goto("/demo/#/suite");
  await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toContainText("Evidence matches");
  await page.locator('[data-testid="suite-input"]').setInputFiles((await suiteBundle()).slice(0, 1));
  await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toContainText("Evidence needs attention");
  await expect(page.getByRole("region", { name: "Suite findings" })).toContainText("Missing evidence: zero-loss.drillrun.json");
  await expect(page.getByRole("button", { name: "Save cases", exact: true })).toBeDisabled();
  await expect(page.locator(".api-status")).toContainText("Go engine");
  await page.locator('[data-testid="suite-input"]').setInputFiles({ name: "suite.json", mimeType: "application/json", buffer: Buffer.from('{"kind":"Wrong"}') });
  await expect(page.getByRole("alert")).toContainText("Not a supported Nostekon LabSuiteResult");
  await expect(page.locator(".suite-table")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download original suite summary" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save cases", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Recorded suite", exact: true }).click();
  await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toContainText("Evidence matches");
});

test("theme preference persists across product, docs and demo pages", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator('[data-theme-toggle] svg:visible')).toHaveAttribute("data-theme-icon", "sun");
  await expect(page.locator("[data-theme-toggle]")).toHaveAttribute("title", "Switch to light mode");
  await page.locator("[data-theme-toggle]").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator('[data-theme-toggle] svg:visible')).toHaveAttribute("data-theme-icon", "moon");
  await expect(page.locator("[data-theme-toggle]")).toHaveAttribute("title", "Switch to dark mode");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("nostekon-theme"))).toBe("light");

  await page.getByRole("link", { name: "Product", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator('[data-theme-toggle] svg:visible')).toHaveAttribute("data-theme-icon", "moon");
  await page.getByRole("link", { name: "Docs", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-md-color-scheme", "default");

  await page.locator('label[for="__palette_1"]').click();
  await expect(page.locator("body")).toHaveAttribute("data-md-color-scheme", "slate");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("nostekon-theme"))).toBe("dark");

  await page.goto("/demo/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("heading", { name: "Recovery runs" })).toBeVisible();
  await page.goto("/product/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator('[data-theme-toggle] svg:visible')).toHaveAttribute("data-theme-icon", "sun");
});

test("report product captures include trust controls and a separate failed recovery", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/demo/#/report");
  await page.getByRole("button", { name: /Isolated PostgreSQL restore/ }).click();
  await expect(page.locator(".verdict.verified h2")).toHaveText("Verified to V3");
  for (const theme of ["dark", "light"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("[data-theme-toggle]").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: testInfo.outputPath(`report-lab-${theme}.png`) });
  }
  await page.getByRole("button", { name: /CRUD cluster loss/ }).click();
  await expect(page.locator(".verdict.failed h2")).toHaveText("Failed at V3: table row counts");
  await expect(page.getByRole("region", { name: "Evidence trust", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "V3 failed", exact: true })).toHaveAttribute("aria-pressed", "true");
  const detail = await page.locator(".level-detail").boundingBox();
  expect(detail!.y + detail!.height).toBeLessThan(900);
  await page.evaluate(() => document.fonts.ready);
  for (const theme of ["dark", "light"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("[data-theme-toggle]").click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath(`report-failed-${theme}.png`) });
  }
  await page.goto("/demo/#/suite");
  await expect(page.getByRole("status", { name: "Suite evidence agreement" })).toContainText("Evidence matches");
  await expect(page.locator(".suite-table tbody tr")).toHaveCount(3);
  for (const theme of ["dark", "light"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("[data-theme-toggle]").click();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: testInfo.outputPath(`policy-suite-${theme}.png`) });
  }
});

test("browser demo requires an explicitly trusted public key for a detached attestation", async ({ page }) => {
  await page.goto("/demo/#/report");
  await page.getByRole("button", { name: /Isolated PostgreSQL restore/ }).click();
  await page.getByRole("button", { name: "Attach attestation" }).click();
  await page.locator('input[data-testid="attestation-input"]').setInputFiles({
    name: "run.attestation.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"apiVersion":"nostekon/attestation/v1alpha1"}'),
  });
  await expect(page.getByRole("button", { name: "Verify signature", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Download signed originals", exact: true })).toBeDisabled();
  await expect(page.getByRole("status", { name: "Signature verification" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Check server trust", exact: true })).toHaveCount(0);
  await expect(page.getByRole("status", { name: "Evidence provenance" })).toContainText("unverified");
});

for (const width of [390, 1440]) {
  test(`original brand assets render across themes at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => localStorage.setItem("nostekon-theme", value), theme);
      for (const path of ["/roadmap/", "/demo/", "/docs/"]) {
        await page.goto(path);
        const mark = page.locator(path === "/demo/" ? ".brand-mark" : path === "/docs/" ? ".md-header .md-logo img" : ".wordmark-mark");
        await expect(mark).toHaveAttribute("src", /nostekon-mark|^data:image\/svg\+xml,/);
        await expect.poll(() => mark.evaluate((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true);
        const favicon = page.locator('link[rel="icon"]');
        await expect(favicon).toHaveAttribute("href", /nostekon-mark|^data:image\/svg\+xml,/);
        const asset = await page.evaluate(async (source) => {
          const response = await fetch(source);
          return { status: response.status, text: await response.text() };
        }, new URL((await mark.getAttribute("src"))!, page.url()).href);
        expect(asset.status).toBe(200);
        expect(asset.text).toContain("Nostekon stepping-stones mark");
        if (path !== "/docs/") {
          await expect(mark).toBeVisible();
          const toggle = page.locator("[data-theme-toggle]");
          await expect(toggle.locator("svg:visible")).toHaveAttribute("data-theme-icon", theme === "dark" ? "sun" : "moon");
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: testInfo.outputPath(`${path.replaceAll("/", "")}-${theme}.png`), fullPage: true });
      }
    }
  });
}

test("homepage explains the product and its commands", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Nostekon", exact: true })).toBeVisible();
  await expect(page.locator(".hero").getByRole("link", { name: "Open the policy suite" })).toHaveAttribute("href", "/demo/index.html#/suite");
  await expect(page.locator(".hero").getByRole("link", { name: "Get the local app" })).toHaveAttribute("href", "/download/");
  await expect(page.getByText("The demo evaluates evidence; it does not connect to Kubernetes.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "What a report tells you" })).toBeVisible();
  await expect(page.locator(".step")).toHaveCount(3);
  await expect(page.locator(".step-state", { hasText: "Local CLI" })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Not built yet" })).toBeVisible();
  await expect.poll(() => page.locator(".shot img:visible").evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth === 1280 && image.naturalHeight === 900)).toBe(true);

  await expect(page.locator("#quickstart-install")).toContainText("git clone https://github.com/jagarkarlo/nostekon.git");
  await expect(page.locator("#quickstart-install")).toContainText("docker compose up --build -d");
  await expect(page.locator("#quickstart-report")).toContainText("--suite examples/suites/postgresql-policy");
  await expect(page.locator("#quickstart")).toContainText("Lab execution is off");
  await expect(page.locator("main")).not.toContainText("repository is private");
  await expect(page.locator("main")).not.toContainText("checked to V3");
  for (const label of ["Copy app setup commands", "Copy suite gate commands"]) {
    await expect(page.getByRole("button", { name: label })).toBeVisible();
  }
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const copyButton = page.locator('button[data-copy-target="quickstart-install"]');
  await copyButton.click();
  await expect(copyButton).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("git clone https://github.com/jagarkarlo/nostekon.git");

  await expect(page.getByRole("link", { name: "GitHub repository" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("site stays readable, self-hosted and free of decoration", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") external.push(url.hostname);
  });
  for (const path of ["/", "/product/", "/download/", "/evidence/", "/roadmap/", "/legal/privacy/", "/legal/terms/", "/legal/trademark/", "/legal/license/"]) {
    await page.goto(path);
    await expect(page.locator("h1")).toHaveCount(1);
    const smallText = await page.evaluate(() => {
      const found: string[] = [];
      for (const element of document.querySelectorAll("main *, header *, footer *")) {
        const own = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
        if (own && parseFloat(getComputedStyle(element).fontSize) < 13) found.push(`${element.tagName}.${element.className}`);
      }
      return found;
    });
    expect(smallText, `${path} has text under 13px`).toEqual([]);
    const effects = await page.evaluate(() =>
      [...document.querySelectorAll("main *")].filter((element) => {
        const style = getComputedStyle(element);
        return style.textShadow !== "none" || /rgba?\([^)]*\)\s+0px 0px \d+px/.test(style.boxShadow) || style.textTransform === "uppercase";
      }).map((element) => `${element.tagName}.${element.className}`),
    );
    expect(effects, `${path} has glow or uppercase labels`).toEqual([]);
  }
  expect(external).toEqual([]);
});

test("saved evidence survives reload, compares and deletes", async ({ page }) => {
  await page.goto("/demo/");
  await expect(page.getByRole("heading", { name: "Recovery runs" })).toBeVisible();
  await page.getByRole("button", { name: /Isolated PostgreSQL restore/ }).click();
  await expect(page.getByRole("heading", { name: "Verified to V3" })).toBeVisible();
  await page.getByRole("button", { name: "Save run", exact: true }).click();
  await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /CRUD cluster loss/ }).click();
  await expect(page.getByRole("heading", { name: /Failed at V3/ })).toBeVisible();
  await page.getByRole("button", { name: "Save run", exact: true }).click();
  await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await page.reload();
  await expect(page.locator(".runs-table tbody tr")).toHaveCount(2);
  await page.locator(".saved-runs tbody").getByRole("checkbox").nth(0).check();
  await page.locator(".saved-runs tbody").getByRole("checkbox").nth(1).check();
  await page.getByRole("button", { name: "Compare (2/2)" }).click();
  await expect(page.getByRole("region", { name: "Run comparison" })).toBeVisible();
  await expect(page.getByText("Different or unknown scenarios.", { exact: false })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search runs" }).fill("no-such-run");
  await expect(page.getByRole("heading", { name: "No matching runs" })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search runs" }).fill("");
  await page.getByRole("button", { name: /^Delete checkride-/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete run" }).click();
  await expect(page.locator(".saved-runs tbody tr")).toHaveCount(1);
  await page.reload();
  await expect(page.locator(".saved-runs tbody tr")).toHaveCount(1);
});

test("run comparison exposes different recovery policies", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/demo/");
  for (const label of ["PostgreSQL RPO exceeded", "PostgreSQL loss within budget"]) {
    await page.getByRole("button", { name: new RegExp(label) }).click();
    await page.getByRole("button", { name: "Save run", exact: true }).click();
    await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
  }
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await page.locator(".saved-runs tbody").getByRole("checkbox").nth(0).check();
  await page.locator(".saved-runs tbody").getByRole("checkbox").nth(1).check();
  await page.getByRole("button", { name: "Compare (2/2)" }).click();
  const comparison = page.getByRole("region", { name: "Run comparison" });
  await expect(comparison).toContainText("Different recovery objectives. Verdicts use different policies.");
  const objective = comparison.getByRole("row").filter({ hasText: "RPO objective" });
  await expect(objective).toContainText("0s");
  await expect(objective).toContainText("1m");
  await expect(comparison.getByRole("row").filter({ hasText: "Acknowledged writes lost" }).getByRole("cell")).toHaveText(["2", "2"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("policy-comparison-mobile.png"), fullPage: true });
});

test("imported evidence uses the browser engine and exports the original", async ({ page }) => {
  await page.goto("/demo/");
    const source = await readFile(new URL("../../examples/runs/k3d-postgresql.run.json", import.meta.url));
  await page.getByTestId("run-evidence-input").setInputFiles({ name: "lab.json", mimeType: "application/json", buffer: source });
  await expect(page.getByRole("heading", { name: "Verified to V3" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Evidence provenance" })).toContainText("signature unverified");
  await expect(page.locator(".api-status")).toContainText("Go engine");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download original evidence" }).click();
  const downloaded = await download;
  expect(await readFile((await downloaded.path())!)).toEqual(source);
  await page.getByRole("button", { name: "Save run", exact: true }).click();
  await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await expect(page.getByText("Imported evidence", { exact: true })).toBeVisible();
});

test("invalid imported evidence cannot be saved as a previous green result", async ({ page }) => {
  await page.goto("/demo/");
  await page.getByRole("button", { name: /Isolated PostgreSQL restore/ }).click();
  await expect(page.getByRole("heading", { name: "Verified to V3" })).toBeVisible();
  await page.locator('[data-testid="evidence-input"]').setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from('{"kind":"Wrong"}') });
  await expect(page.getByRole("tab", { name: /Evidence JSON/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".evidence-problems")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save run", exact: true })).toBeDisabled();
});

test("docs, deep links, search and demo navigation work", async ({ page }) => {
  const response = await page.goto("/docs/");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: /^Nostekon Documentation/ })).toBeVisible();
  await page.getByRole("link", { name: "Installation", exact: true }).first().click();
  await expect(page).toHaveURL(/\/docs\/start\//);
  const search = page.getByRole("textbox", { name: "Search", exact: true });
  await search.click();
  await search.pressSequentially("DrillRun", { delay: 40 });
  await expect(page.locator(".md-search-result__link").first()).toBeVisible();
  for (const path of ["/docs/guides/k3d-isolated-restore/", "/docs/reference/drillrun-evidence/", "/demo/"]) {
    expect((await page.request.get(path)).status()).toBe(200);
  }
});

for (const width of [390, 1440]) {
  for (const sample of [
    { label: "PostgreSQL zero loss", heading: "Verified to V4", lost: "0", acknowledged: 10, objective: "objective 0s · met", verdict: "verified" },
    { label: "PostgreSQL RPO exceeded", heading: /^Failed at V4/, lost: "2", acknowledged: 12, objective: "objective 0s · missed", verdict: "failed" },
    { label: "PostgreSQL loss within budget", heading: "Verified to V4", lost: "2", acknowledged: 12, objective: "objective 1m · met", verdict: "verified" },
  ]) {
    test(`recorded ledger ${sample.label} at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/demo/");
      await expect(page.getByRole("button", { name: "Recorded lab", exact: true })).toContainText("5");
      await expect(page.getByRole("button", { name: "Synthetic", exact: true })).toContainText("2");
      await page.getByRole("button", { name: new RegExp(sample.label) }).click();
      await expect(page.getByRole("heading", { name: sample.heading })).toBeVisible();
      await expect(page.locator(".sample-caveat")).toContainText("Recorded local lab run");
      await expect(page.locator(".sample-caveat")).not.toContainText("synthetic");
      await expect(page.locator(".metric").filter({ hasText: "Writes lost" }).locator(".metric-value")).toHaveText(sample.lost);
      await expect(page.locator(".metric").filter({ hasText: "Writes lost" })).toContainText(`of ${sample.acknowledged} acknowledged`);
      await expect(page.locator(".metric").filter({ hasText: "Data loss window" })).toContainText(sample.objective);
      await expect(page.getByRole("img", { name: `10 writes recovered and ${sample.lost} lost before the failure` })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: testInfo.outputPath("recorded-ledger.png"), fullPage: true });
      await page.getByRole("button", { name: "Save run", exact: true }).click();
      await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
      await page.getByRole("link", { name: "Runs", exact: true }).click();
      await page.reload();
      const saved = page.locator(".runs-table tbody tr");
      await expect(saved).toHaveCount(1);
      await expect(saved).toContainText("Recorded lab");
      await expect(saved.locator(".verdict-tag")).toHaveText(sample.verdict);
    });
  }

  test(`theme and layout remain usable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto("/demo/");
    await expect(page.getByRole("heading", { name: "Recovery runs" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("runs-light.png"), fullPage: true });
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: /Isolated PostgreSQL restore/ }).click();
    await expect(page.getByRole("heading", { name: "Verified to V3" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("report-dark.png"), fullPage: true });
  });
}