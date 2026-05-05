import { defineConfig } from "@playwright/test";

export default defineConfig({
  testIgnore: ["**/.claude/**", "**/node_modules/**", "**/runs/**"],
});
