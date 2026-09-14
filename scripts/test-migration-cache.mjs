#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const BUILD_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const TERMINATION_GRACE_MS = 5_000;


const PROBE_SOURCE = String.raw`use std::process::ExitCode;

use serde_json::{Map, Value, json};
use sqlx::SqlitePool;

async fn inspect(pool: &SqlitePool) -> Result<Value, sqlx::Error> {
    let mut probes = Map::new();
    for table in ["dbc_added_probe", "dbc_changed_probe", "dbc_removed_probe"] {
        let present = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = ?1",
        )
        .bind(table)
        .fetch_one(pool)
        .await?
            == 1;
        let value = if present {
            let query = format!("SELECT value FROM {table} LIMIT 1");
            Some(sqlx::query_scalar::<_, String>(&query).fetch_one(pool).await?)
        } else {
            None
        };
        probes.insert(table.to_owned(), json!({ "present": present, "value": value }));
    }
    Ok(Value::Object(probes))
}

#[tokio::main]
async fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let Some(operation) = args.next() else {
        eprintln!("usage: migration-probe <migrate|inspect> <database-path>");
        return ExitCode::FAILURE;
    };
    let Some(database_path) = args.next() else {
        eprintln!("usage: migration-probe <migrate|inspect> <database-path>");
        return ExitCode::FAILURE;
    };
    if args.next().is_some() || !matches!(operation.as_str(), "migrate" | "inspect") {
        eprintln!("usage: migration-probe <migrate|inspect> <database-path>");
        return ExitCode::FAILURE;
    }

    let database_url = format!("sqlite:{database_path}");
    let pool = match azuki_db::create_pool(&database_url).await {
        Ok(pool) => pool,
        Err(error) => {
            eprintln!("{error:?}");
            return ExitCode::FAILURE;
        }
    };
    if operation == "migrate" {
        if let Err(error) = azuki_db::run_migrations(&pool).await {
            eprintln!("{error:?}");
            pool.close().await;
            return ExitCode::FAILURE;
        }
    }
    let result = inspect(&pool).await;
    pool.close().await;
    match result {
        Ok(value) => {
            println!("{value}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error:?}");
            ExitCode::FAILURE
        }
    }
}
`;

const ADDED_MIGRATION = `CREATE TABLE dbc_added_probe (value TEXT NOT NULL);\nINSERT INTO dbc_added_probe (value) VALUES ('added');\n`;
const CHANGED_MIGRATION_BEFORE = `CREATE TABLE dbc_changed_probe (value TEXT NOT NULL);\nINSERT INTO dbc_changed_probe (value) VALUES ('before');\n`;
const CHANGED_MIGRATION_AFTER = `CREATE TABLE dbc_changed_probe (value TEXT NOT NULL);\nINSERT INTO dbc_changed_probe (value) VALUES ('after');\n`;
const REMOVED_MIGRATION = `CREATE TABLE dbc_removed_probe (value TEXT NOT NULL);\nINSERT INTO dbc_removed_probe (value) VALUES ('present');\n`;

function usage() {
  return "usage: node scripts/test-migration-cache.mjs [--cargo <cargo>] [--kache <kache-v0.20.0>]";
}

function parseArgs(argv) {
  const options = { cargo: "cargo", kache: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--cargo" && argument !== "--kache") throw new Error(usage());
    const value = argv[index + 1];
    if (!value) throw new Error(usage());
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

function cleanEnvironment(extra = {}) {
  const environment = { ...process.env };
  environment.RUSTC_WRAPPER = "";
  environment.RUSTC_WORKSPACE_WRAPPER = "";
  environment.CARGO_BUILD_RUSTC_WRAPPER = "";
  environment.CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER = "";
  environment.HOST_CC = "cc";
  environment.HOST_CXX = "c++";
  environment.CC_KNOWN_WRAPPER_CUSTOM = "";
  delete environment.CARGO_TARGET_DIR;
  for (const name of Object.keys(environment)) {
    if (name.startsWith("KACHE_")) delete environment[name];
  }
  return { ...environment, SQLX_OFFLINE: "true", ...extra };
}

function run(binary, args, { cwd, env, timeoutMs = BUILD_TIMEOUT_MS } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure = null;
    let killTimer = null;
    let closed = false;

    const terminate = (signal) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") child.kill(signal);
      }
    };
    const failAndTerminate = (error) => {
      if (failure) return;
      failure = error;
      terminate("SIGTERM");
      killTimer = setTimeout(() => {
        terminate("SIGKILL");
        killTimer = null;
        if (closed) reject(failure);
      }, TERMINATION_GRACE_MS);
    };
    const capture = (chunks, chunk, stream) => {
      const current = stream === "stdout" ? stdoutBytes : stderrBytes;
      const remaining = MAX_OUTPUT_BYTES - current;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      if (stream === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (chunk.length > remaining) {
        failAndTerminate(new Error(`${stream} exceeded ${MAX_OUTPUT_BYTES} bytes: ${binary}`));
      }
    };

    const timer = setTimeout(
      () => failAndTerminate(new Error(`timed out: ${binary} ${args.join(" ")}`)),
      timeoutMs,
    );
    child.stdout.on("data", (chunk) => capture(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk) => capture(stderr, chunk, "stderr"));
    child.on("error", (error) => {
      failure ??= error;
    });
    child.on("close", (code, signal) => {
      closed = true;
      clearTimeout(timer);
      if (failure) {
        if (killTimer === null) reject(failure);
        return;
      }
      resolveResult({
        code: code ?? 128,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function runSuccessfully(binary, args, options) {
  const result = await run(binary, args, options);
  assert.equal(
    result.code,
    0,
    `${binary} ${args.join(" ")} failed (${result.signal ?? result.code}):\n${result.stderr}`,
  );
  return result;
}

async function copyAllowedTree(source, destination, extension) {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyAllowedTree(sourcePath, destinationPath, extension);
    } else if (entry.isFile()) {
      if (entry.name.endsWith(extension)) await copyFile(sourcePath, destinationPath);
    } else {
      throw new Error(`source allowlist rejected non-regular path ${sourcePath}`);
    }
  }
}

async function copyWorkspaceCrates(destination) {
  const source = join(PROJECT_ROOT, "crates");
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourceRoot = join(source, entry.name);
    if (entry.isFile()) continue;
    if (!entry.isDirectory()) {
      throw new Error(`source allowlist rejected non-directory crate path ${sourceRoot}`);
    }
    const crateRoot = join(destination, entry.name);
    await mkdir(crateRoot, { recursive: true });
    await copyFile(join(sourceRoot, "Cargo.toml"), join(crateRoot, "Cargo.toml"));
    await copyAllowedTree(join(sourceRoot, "src"), join(crateRoot, "src"), ".rs");
    try {
      await copyFile(join(sourceRoot, "build.rs"), join(crateRoot, "build.rs"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function createFixture(root) {
  await mkdir(root, { recursive: true });
  await copyFile(join(PROJECT_ROOT, "Cargo.toml"), join(root, "Cargo.toml"));
  await copyFile(join(PROJECT_ROOT, "Cargo.lock"), join(root, "Cargo.lock"));
  await copyFile(join(PROJECT_ROOT, ".kache.toml"), join(root, ".kache.toml"));
  await copyWorkspaceCrates(join(root, "crates"));
  const crateRoot = join(root, "crates", "azuki-db");
  await mkdir(join(crateRoot, "examples"), { recursive: true });
  await writeFile(join(crateRoot, "examples", "migration-probe.rs"), PROBE_SOURCE);
  await copyAllowedTree(join(PROJECT_ROOT, "migrations"), join(root, "migrations"), ".sql");
  await writeFile(join(root, "migrations", "901_dbc_changed_probe.sql"), CHANGED_MIGRATION_BEFORE);
  await writeFile(join(root, "migrations", "902_dbc_removed_probe.sql"), REMOVED_MIGRATION);
  return root;
}

function expected({ added, changed, removed }) {
  return {
    dbc_added_probe: { present: added, value: added ? "added" : null },
    dbc_changed_probe: { present: true, value: changed },
    dbc_removed_probe: { present: removed, value: removed ? "present" : null },
  };
}

async function exerciseMode({ name, root, cargo, kache }) {
  const fixture = await createFixture(join(root, name));
  const target = join(fixture, "target");
  const migrations = join(fixture, "migrations");
  const binary = join(target, "debug", "examples", "migration-probe");
  const extra = { CARGO_INCREMENTAL: "0", CARGO_TARGET_DIR: target };
  if (kache) {
    Object.assign(extra, {
      RUSTC_WRAPPER: kache,
      CARGO_BUILD_RUSTC_WRAPPER: kache,
      KACHE_CONFIG: join(fixture, ".kache.toml"),
      KACHE_CACHE_DIR: join(fixture, "kache-store"),
      KACHE_RUNTIME_DIR: join(fixture, "kache-runtime"),
      KACHE_LOCAL_ONLY: "true",
      KACHE_AUTO_GC: "false",
      KACHE_PREFETCH_ENABLED: "false",
      KACHE_LOCAL_HIT_DAEMON: "false",
      KACHE_ADAPTIVE_INCREMENTAL: "false",
    });
  }
  const env = cleanEnvironment(extra);
  const build = () => runSuccessfully(
    cargo,
    ["build", "--locked", "--package", "azuki-db", "--example", "migration-probe"],
    { cwd: fixture, env },
  );
  const migrate = async (database) => {
    const result = await runSuccessfully(binary, ["migrate", database], { cwd: fixture, env });
    return JSON.parse(result.stdout);
  };
  const inspect = async (database) => {
    const result = await runSuccessfully(binary, ["inspect", database], { cwd: fixture, env });
    return JSON.parse(result.stdout);
  };

  await build();
  assert.deepEqual(
    await migrate(join(fixture, "baseline.db")),
    expected({ added: false, changed: "before", removed: true }),
    `${name}: fresh target must compile the initial migrator`,
  );

  if (kache) {
    await rm(target, { recursive: true, force: true });
    await build();
    const reportResult = await runSuccessfully(
      kache,
      ["report", "--format", "json", "--last-build", "--root", fixture],
      { cwd: fixture, env },
    );
    const report = JSON.parse(reportResult.stdout);
    assert.equal(report.schema_version, 1);
    assert.equal(report.meta.kache_version, "0.20.0");
    assert.ok(report.summary.local_hits > 0);
    assert.ok(
      report.all_events.some(
        (event) =>
          event.result === "local_hit" &&
          event.compiler_runs === 0 &&
          event.size > 0,
      ),
      `${name}: an empty target rebuild must restore a real compiler artifact`,
    );
    assert.deepEqual(
      await migrate(join(fixture, "kache-restored.db")),
      expected({ added: false, changed: "before", removed: true }),
      `${name}: the kache-restored binary must contain the current migrator`,
    );
  }

  await writeFile(join(migrations, "900_dbc_added_probe.sql"), ADDED_MIGRATION);
  await build();
  assert.deepEqual(
    await migrate(join(fixture, "added.db")),
    expected({ added: true, changed: "before", removed: true }),
    `${name}: adding a migration must rebuild the embedded migrator`,
  );
  const oldChangeDatabase = join(fixture, "before-change.db");
  const oldChangeState = await migrate(oldChangeDatabase);

  await writeFile(join(migrations, "901_dbc_changed_probe.sql"), CHANGED_MIGRATION_AFTER);
  await build();
  assert.deepEqual(
    await migrate(join(fixture, "changed.db")),
    expected({ added: true, changed: "after", removed: true }),
    `${name}: changing a migration must rebuild the embedded migrator`,
  );
  const checksumRejected = await run(binary, ["migrate", oldChangeDatabase], { cwd: fixture, env });
  assert.notEqual(checksumRejected.code, 0, `${name}: changed applied migration must be rejected`);
  assert.match(checksumRejected.stderr, /VersionMismatch\(901\)/);
  assert.deepEqual(await inspect(oldChangeDatabase), oldChangeState);

  const oldRemoveDatabase = join(fixture, "before-remove.db");
  const oldRemoveState = await migrate(oldRemoveDatabase);
  await rm(join(migrations, "902_dbc_removed_probe.sql"));
  await build();
  assert.deepEqual(
    await migrate(join(fixture, "removed.db")),
    expected({ added: true, changed: "after", removed: false }),
    `${name}: removing a migration must rebuild the embedded migrator`,
  );
  const missingRejected = await run(binary, ["migrate", oldRemoveDatabase], { cwd: fixture, env });
  assert.notEqual(missingRejected.code, 0, `${name}: removed applied migration must be rejected`);
  assert.match(missingRejected.stderr, /VersionMissing\(902\)/);
  assert.deepEqual(await inspect(oldRemoveDatabase), oldRemoveState);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const kache = options.kache ? resolve(options.kache) : null;
  if (kache) {
    const version = await runSuccessfully(kache, ["--version"], { env: cleanEnvironment(), timeoutMs: 10_000 });
    assert.match(version.stdout, /\b0\.20\.0\b/, "--kache must name kache v0.20.0");
  }

  const root = await mkdtemp(join(tmpdir(), "azuki-migration-cache-"));
  try {
    await exerciseMode({ name: "wrapper-free", root, cargo: options.cargo, kache: null });
    if (kache) await exerciseMode({ name: "kache", root, cargo: options.cargo, kache });
    process.stdout.write(`migration cache regression passed: wrapper-free${kache ? " + kache v0.20.0" : ""}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${basename(process.argv[1])}: ${error.stack ?? error}\n`);
  process.exitCode = 1;
});
