import { defineConfig } from "vitest/config";

// Test files that use the database reset the same schema, so they must not run in parallel.
export default defineConfig({ test: { fileParallelism: false } });
