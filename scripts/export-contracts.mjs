import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const files = ["worker-message.schema.json", "fixtures.json", "operation-catalog.json"];
const manifest = { version: "1.2.0", files: {} };
for (const file of files) {
  const bytes = await readFile(`contracts/${file}`);
  manifest.files[file] = createHash("sha256").update(bytes).digest("hex");
}
await writeFile(
  "contracts/manifest.json",
  JSON.stringify(manifest, null, 2) + "\n",
);
const targets = process.argv.slice(2);
for (const target of targets) {
  await mkdir(target, { recursive: true });
  for (const file of [...files, "manifest.json"])
    await writeFile(resolve(target, file), await readFile(`contracts/${file}`));
}
console.log("Contract 1.2.0 exported", targets);
