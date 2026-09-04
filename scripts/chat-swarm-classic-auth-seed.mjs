import Database from "better-sqlite3";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

const sourceProfile = resolve(String(arg("source-profile")).trim());
const targetProfile = resolve(String(arg("target-profile")).trim());

if (!sourceProfile || !targetProfile) {
  console.error("--source-profile and --target-profile are required.");
  process.exit(2);
}
if (sourceProfile.toLowerCase() === targetProfile.toLowerCase()) {
  console.error("Source and target profiles must be different.");
  process.exit(2);
}

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function copyIfPresent(relativePath) {
  const source = join(sourceProfile, relativePath);
  if (!(await exists(source))) return false;
  const target = join(targetProfile, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  return true;
}

function authSeedError(stage, reason) {
  const error = new Error(`${stage}:${reason}`);
  error.stage = stage;
  error.reason = reason;
  return error;
}

async function backupCookies() {
  const source = join(sourceProfile, "Network", "Cookies");
  if (!(await exists(source))) throw authSeedError("source", "source-missing");
  const target = join(targetProfile, "Network", "Cookies");
  const temporary = `${target}.devspace-${process.pid}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await rm(temporary, { force: true });

  let database;
  try {
    database = new Database(source, { readonly: true, fileMustExist: true });
  } catch (error) {
    const code = String(error?.code || "");
    const message = String(error?.message || "");
    const locked = code === "SQLITE_CANTOPEN" || /unable to open database file/i.test(message);
    throw authSeedError("source-open", locked ? "source-locked" : "source-open-failed");
  }
  try {
    // better-sqlite3's online backup API reads a consistent SQLite snapshot while
    // Chromium continues using the source DB. Cookie values stay encrypted by
    // Chromium/Windows; DevSpace never reads or logs them.
    try {
      await database.backup(temporary);
    } catch {
      throw authSeedError("target-backup", "target-backup-failed");
    }
  } finally {
    database.close();
  }
  await rm(target, { force: true });
  await rename(temporary, target);
  return true;
}

try {
  await mkdir(targetProfile, { recursive: true });
  const localState = await copyIfPresent("Local State");
  const preferences = await copyIfPresent("Preferences");
  const cookies = await backupCookies();
  console.log(JSON.stringify({ ok: true, localState, preferences, cookies, secretValuesLogged: false }));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    stage: String(error?.stage || "unknown"),
    reason: String(error?.reason || "unexpected"),
    secretValuesLogged: false,
  }));
  process.exit(1);
}
