import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test("native browser behavior and accessibility", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Calculate" }).click();
  await expect(page.locator("#result")).toHaveText("204");
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations).toEqual([]);
});
