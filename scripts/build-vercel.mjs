import { cp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function run(command, args) {
  const { stdout, stderr } = await exec(command, args, { stdio: "pipe" });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

await rm("apps/h5/dist", { recursive: true, force: true });
await rm("apps/admin/dist", { recursive: true, force: true });
await run("npm", ["--workspace", "@tosell/h5", "run", "build"]);
await run("npm", ["--workspace", "@tosell/admin", "run", "build"]);
await rm("apps/h5/dist/admin", { recursive: true, force: true });
await cp("apps/admin/dist", "apps/h5/dist/admin", { recursive: true });
