const required = {
  APP_ENV: "production",
  ALLOW_DEMO_AUTH: "false",
  MOCK_PAYMENT_ENABLED: "false"
};

const failures = [];

for (const [key, expected] of Object.entries(required)) {
  if ((process.env[key] ?? "").trim() !== expected) {
    failures.push(`${key} must be ${expected}`);
  }
}

const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
if (!databaseUrl) {
  failures.push("DATABASE_URL is required");
}

if (/CHANGE_ME|example|memory|sqlite|neondb|ep-floral-tree|channel_binding=require/i.test(databaseUrl)) {
  failures.push("DATABASE_URL contains a placeholder, memory/sqlite, old cloud database, or example value");
}

let parsed;
if (databaseUrl) {
  try {
    parsed = new URL(databaseUrl);
  } catch {
    failures.push("DATABASE_URL must be a valid PostgreSQL URL");
  }
}

if (parsed) {
  const protocolOk = parsed.protocol === "postgresql:" || parsed.protocol === "postgres:";
  if (!protocolOk) failures.push("DATABASE_URL must use postgresql://");

  const host = parsed.hostname;
  const port = parsed.port || "5432";
  const dbName = parsed.pathname.replace(/^\//, "");
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);

  if (user !== "tosell") failures.push("DATABASE_URL user must be tosell for Google VM PostgreSQL tests");
  if (dbName !== "tosell") failures.push("DATABASE_URL database name must be tosell");
  if (!password) failures.push("DATABASE_URL must include the real database password");

  const allowedTargets = [
    host === "127.0.0.1" && port === "15432",
    host === "localhost" && port === "15432",
    host === "127.0.0.1" && port === "5432" && process.env.TOSELL_RUNNING_ON_GCP_VM === "true",
    host === "localhost" && port === "5432" && process.env.TOSELL_RUNNING_ON_GCP_VM === "true",
    host === "10.128.0.2" && port === "5432"
  ];

  if (!allowedTargets.some(Boolean)) {
    failures.push("DATABASE_URL must target the Google VM PostgreSQL service or the documented SSH tunnel on 127.0.0.1:15432");
  }
}

if (failures.length > 0) {
  console.error("Real database test guard failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error("");
  console.error("See docs/ops-connection-map.md and AGENTS.md.");
  process.exit(1);
}

try {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl
      }
    }
  });

  try {
    const result = await prisma.$queryRaw`SELECT current_database() AS database_name, current_user AS database_user`;
    const row = Array.isArray(result) ? result[0] : undefined;
    if (row?.database_name !== "tosell" || row?.database_user !== "tosell") {
      console.error("Real database test guard failed:");
      console.error("- Connected database identity does not match Google VM PostgreSQL policy");
      process.exit(1);
    }
  } finally {
    await prisma.$disconnect();
  }
} catch (error) {
  console.error("Real database test guard failed:");
  console.error("- Could not connect to the configured Google VM PostgreSQL database");
  console.error(`- ${error instanceof Error ? error.message.replace(databaseUrl, "<redacted>") : "Unknown database connection error"}`);
  process.exit(1);
}

console.log("Real database test guard passed: Google VM PostgreSQL connection verified.");
