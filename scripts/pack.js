import { mkdir, mkdtemp, cp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), "request-catcher-pack-"));
const dist = path.join(root, "dist");
try {
  await mkdir(dist, { recursive: true });
  for (const file of ["manifest.json", "background.js", "src", "panel.html", "panel.css", "panel.js", "README.md"]) {
    await cp(path.join(root, file), path.join(temp, "request-catcher", file), { recursive: true });
  }
  const archive = path.join(dist, "request-catcher.zip");
  await rm(archive, { force: true });
  const result = spawnSync("zip", ["-qr", archive, "request-catcher"], { cwd: temp, stdio: "inherit" });
  if (result.status !== 0) throw new Error("Не удалось создать ZIP. Нужна утилита zip.");
  console.log(archive);
} finally { await rm(temp, { recursive: true, force: true }); }
