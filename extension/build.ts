import { cp, mkdir, rm } from "node:fs/promises";
import { watch } from "node:fs";

const ENTRIES = ["src/background.ts", "src/content/content.ts", "src/popup.ts", "src/options.ts"];

async function build() {
  const t0 = performance.now();
  await rm("dist", { recursive: true, force: true });
  await mkdir("dist");
  const res = await Bun.build({
    entrypoints: ENTRIES,
    outdir: "dist",
    naming: "[name].[ext]",
    format: "iife",
    target: "browser",
    minify: !process.argv.includes("--watch"),
    sourcemap: process.argv.includes("--watch") ? "inline" : "none",
  });
  if (!res.success) {
    for (const log of res.logs) console.error(log);
    return;
  }
  await cp("static", "dist", { recursive: true });
  console.log(`built dist/ in ${Math.round(performance.now() - t0)}ms`);
}

await build();

if (process.argv.includes("--watch")) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  for (const dir of ["src", "static"]) {
    watch(dir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(build, 80);
    });
  }
  console.log("watching src/ and static/ …");
}
