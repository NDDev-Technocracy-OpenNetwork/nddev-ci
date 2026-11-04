import { defineConfig } from "@playwright/test";
const port = Number(process.env.NDDEV_WEB_PORT);
export default defineConfig({
  testMatch: "web.spec.js",
  workers: 1,
  retries: 0,
  use: { baseURL: `http://127.0.0.1:${port}` },
  reporter: [["list"], ["junit", { outputFile: ".nddev-reports/web.xml" }]],
  webServer: {
    command: "node server.mjs",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 10000,
  },
});
