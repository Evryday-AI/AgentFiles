import { defineConfig } from "@playwright/test";
const port = process.env.AGENTFILES_BROWSER_PORT;
if (
  !port ||
  !process.env.AGENTFILES_BROWSER_FIXTURE_DIR ||
  !process.env.AGENTFILES_TEST_DATABASE_URL
)
  throw new Error(
    "Run the independent test:browser launcher with an explicit test database",
  );
export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  retries: 0,
  timeout: 30000,
  reporter: "line",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
    { name: "phone-viewport", use: { viewport: { width: 390, height: 844 } } },
    { name: "minimum-width", use: { viewport: { width: 320, height: 740 } } },
  ],
  webServer: {
    command: "node --import tsx tests/browser/fixtureServer.ts",
    url: `http://127.0.0.1:${port}/api/ready`,
    reuseExistingServer: false,
    timeout: 120000,
    stdout: "ignore",
    stderr: "ignore",
  },
});
