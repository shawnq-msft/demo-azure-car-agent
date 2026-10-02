import { loadEnvFile } from "node:process";
import { realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverWebIq, WebIqDiscoveryError } from "../apps/api/src/webiq.ts";

async function main() {
  const args = process.argv.slice(2);
  if (!(args.length === 0 || (args.length === 2 && args[0] === "--output" && isAbsolute(args[1])))) {
    throw new Error("Usage: npm exec -- tsx scripts/discover-webiq.mjs [--output ABSOLUTE_PATH_OUTSIDE_REPO]");
  }
  const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  let output;
  if (args.length) {
    const target = resolve(args[1]);
    const parent = await realpath(dirname(target));
    output = resolve(parent, basename(target));
    const within = relative(root, output);
    if (within === "" || (!isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`))) {
      throw new Error("Output must be outside the repository.");
    }
  }
  try {
    loadEnvFile(resolve(root, "apps", "api", ".env"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error("Unable to load the backend environment file.");
  }
  const key = process.env.WEB_IQ_API_KEY;
  const discovery = await discoverWebIq(key);
  if (output) {
    // Preserve structure, not provider prose/example content. This is a review artifact, not a contract.
    const omitted = new Set(["description", "title", "examples", "example", "default", "$comment", "_meta"]);
    const clean = (value) => {
      if (typeof value === "string") return value.split(key).join("[REDACTED]");
      if (Array.isArray(value)) return value.map(clean);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value)
          .filter(([name]) => !omitted.has(name))
          .map(([name, child]) => [name.split(key).join("[REDACTED]"), clean(child)]));
      }
      return value;
    };
    await writeFile(output, `${JSON.stringify(clean(discovery), null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  console.log(`Web IQ discovery completed: ${discovery.tools.length} tool schema(s).${output ? " Sanitized artifact written." : " No artifact written."}`);
}

main().catch((error) => {
  // Never print provider payloads, environment values, filesystem paths, or error causes.
  console.error(error instanceof WebIqDiscoveryError ? error.message : "Web IQ discovery failed. Check arguments, environment, and the new external output path.");
  process.exitCode = 1;
});
