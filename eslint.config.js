// @ts-check
import { baseConfig, boundariesConfig, webRuntimeConfig } from "@repo/shared/config/eslint";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.mastra/**",
      "**/.wrangler/**",
      "**/.direnv/**",
    ],
  },
  ...baseConfig(),
  ...boundariesConfig(),
  ...webRuntimeConfig(),
];
