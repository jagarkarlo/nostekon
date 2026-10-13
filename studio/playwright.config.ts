import { defineConfig } from "@playwright/test";

const appURL = process.env.NOSTEKON_APP_URL;
const siteURL = process.env.NOSTEKON_SITE_URL;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  fullyParallel: true,
    use: { baseURL: appURL ?? siteURL ?? "http://127.0.0.1:4326", viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure" },
  webServer: appURL || siteURL ? undefined : {
      command: "python3 -m http.server 4326 --bind 127.0.0.1 --directory ../site/dist",
      url: "http://127.0.0.1:4326/demo/",
    reuseExistingServer: false,
  },
});