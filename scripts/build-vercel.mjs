import { cp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function run(command, args) {
  const { stdout, stderr } = await exec(command, args, { stdio: "pipe" });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

async function tryRun(command, args) {
  try {
    await run(command, args);
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? error.stderr : "";
    const stdout = error && typeof error === "object" && "stdout" in error ? error.stdout : "";
    const output = `${stdout ?? ""}${stderr ?? ""}`;
    if (!output.includes("P3008") && !output.includes("P3012")) {
      throw error;
    }
  }
}

await rm("apps/h5/dist", { recursive: true, force: true });
await rm("apps/admin/dist", { recursive: true, force: true });
if (process.env.TOSELL_RUN_MIGRATIONS === "1") {
  await tryRun("npx", ["prisma", "migrate", "resolve", "--rolled-back", "000019_admin_backend_ux_data_contract", "--schema", "packages/database/prisma/schema.prisma"]);
  await run("npx", ["prisma", "migrate", "deploy", "--schema", "packages/database/prisma/schema.prisma"]);
}
if (process.env.TOSELL_RUN_E2E_SETUP === "1") {
  await run("npm", ["run", "db:e2e-setup"]);
}
await run("npx", ["prisma", "generate", "--schema", "packages/database/prisma/schema.prisma"]);
await run("npm", ["--workspace", "@tosell/h5", "run", "build"]);
await run("npm", ["--workspace", "@tosell/admin", "run", "build"]);
await rm("apps/h5/dist/admin", { recursive: true, force: true });
await cp("apps/admin/dist", "apps/h5/dist/admin", { recursive: true });
