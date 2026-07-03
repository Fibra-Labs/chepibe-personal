import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/main.ts"],
  format: ["esm"],
  dts: {
    tsconfig: "./tsconfig.json",
  },
  clean: true,
  sourcemap: true,
  external: ["@chepibe-personal/shared"],
});
