#!/usr/bin/env bun
/**
 * Local macOS release script for Katib
 *
 * Usage:
 *   bun run release           # Patch bump (0.7.10 → 0.7.11)
 *   bun run release:minor     # Minor bump (0.7.10 → 0.8.0)
 *   bun run release:major     # Major bump (0.7.10 → 1.0.0)
 *
 * Flow:
 *   1. Load .env.local and validate required variables
 *   2. Check for uncommitted changes
 *   3. Bump version in tauri.conf.json + package.json + Cargo.toml
 *   4. Commit version bump (includes Cargo.lock)
 *   5. Import Apple certificate into temporary keychain
 *   6. Build macOS with Tauri (aarch64-apple-darwin)
 *   7. Upload artifacts to Supabase Storage (katib_releases)
 *   8. Generate and upload latest.json
 *   9. Create git tag + push
 *   10. Cleanup temporary keychain
 */

import { $, Glob } from "bun";
import { readFile, writeFile, copyFile } from "fs/promises";
import { join, basename } from "path";
import { existsSync } from "fs";

// Paths
const SCRIPT_DIR = import.meta.dir;
const PROJECT_ROOT = join(SCRIPT_DIR, "..");
const ENV_FILE = join(PROJECT_ROOT, ".env.local");
const TAURI_CONFIG_PATH = join(PROJECT_ROOT, "src-tauri/tauri.conf.json");
const PACKAGE_JSON_PATH = join(PROJECT_ROOT, "package.json");
const CARGO_TOML_PATH = join(PROJECT_ROOT, "src-tauri/Cargo.toml");
const CARGO_LOCK_PATH = join(PROJECT_ROOT, "src-tauri/Cargo.lock");
const BUNDLE_DIR = join(
  PROJECT_ROOT,
  "src-tauri/target/aarch64-apple-darwin/release/bundle"
);

// Supabase
const BUCKET = "katib_releases";

// Colors
const colors = {
  red: "\x1b[0;31m",
  green: "\x1b[0;32m",
  yellow: "\x1b[1;33m",
  reset: "\x1b[0m",
};

function log(message: string, color: keyof typeof colors = "reset") {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

type BumpType = "major" | "minor" | "patch";

const REQUIRED_ENV_VARS = [
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "SUPABASE_SERVICE_KEY",
  "SUPABASE_URL",
];

function bumpVersion(version: string, type: BumpType): string {
  const [major, minor, patch] = version.split(".").map(Number);

  switch (type) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
    default:
      return `${major}.${minor}.${patch + 1}`;
  }
}

async function uploadFile(
  filePath: string,
  supabaseUrl: string,
  serviceKey: string
): Promise<boolean> {
  const fileName = basename(filePath);
  log(`Uploading ${fileName}...`, "yellow");

  const fileContent = await Bun.file(filePath).arrayBuffer();

  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/${BUCKET}/${fileName}`,
    {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/octet-stream",
        "x-upsert": "true",
      },
      body: fileContent,
    }
  );

  if (response.ok) {
    log(`  Uploaded ${fileName}`, "green");
    return true;
  } else {
    const text = await response.text();
    log(`  Failed to upload ${fileName} (HTTP ${response.status}: ${text})`, "red");
    return false;
  }
}

async function findArtifacts(): Promise<{
  dmg: string;
  tar: string;
  sig: string;
}> {
  const dmgDir = join(BUNDLE_DIR, "dmg");
  const macosDir = join(BUNDLE_DIR, "macos");

  const dmgFiles: string[] = [];
  for await (const f of new Glob("*.dmg").scan({ cwd: dmgDir })) {
    dmgFiles.push(f);
  }

  const tarFiles: string[] = [];
  const sigFiles: string[] = [];
  for await (const f of new Glob("*.app.tar.gz*").scan({ cwd: macosDir })) {
    if (f.endsWith(".sig")) {
      sigFiles.push(f);
    } else {
      tarFiles.push(f);
    }
  }

  if (!dmgFiles[0] || !tarFiles[0] || !sigFiles[0]) {
    throw new Error(
      `Could not find all required build artifacts in ${BUNDLE_DIR}`
    );
  }

  return {
    dmg: join(dmgDir, dmgFiles[0]),
    tar: join(macosDir, tarFiles[0]),
    sig: join(macosDir, sigFiles[0]),
  };
}

async function setupKeychain(env: Record<string, string>) {
  log("\nImporting Apple certificate into temporary keychain...", "yellow");

  await $`echo ${env.APPLE_CERTIFICATE} | base64 --decode > /tmp/certificate.p12`;
  await $`security create-keychain -p "build" build.keychain`;
  await $`security default-keychain -s build.keychain`;
  await $`security unlock-keychain -p "build" build.keychain`;
  await $`security set-keychain-settings -t 3600 -u build.keychain`;
  await $`security import /tmp/certificate.p12 -k build.keychain -P ${env.APPLE_CERTIFICATE_PASSWORD} -T /usr/bin/codesign`;
  await $`security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "build" build.keychain`;

  log("  Keychain ready", "green");
}

async function cleanupKeychain() {
  log("\nCleaning up temporary keychain...", "yellow");
  try {
    await $`security default-keychain -s login.keychain`;
    await $`security delete-keychain build.keychain`;
    await $`rm -f /tmp/certificate.p12`;
    log("  Keychain cleaned up", "green");
  } catch {
    log("  Warning: keychain cleanup had issues (non-fatal)", "yellow");
  }
}

async function main() {
  const bumpType = (process.argv[2] as BumpType) || "patch";

  if (!["major", "minor", "patch"].includes(bumpType)) {
    console.error("Usage: bun run release [major|minor|patch]");
    process.exit(1);
  }

  log("Katib Release Script (macOS)", "green");
  log("============================\n");

  // 1. Load environment variables
  log("Loading environment variables...", "yellow");
  if (!existsSync(ENV_FILE)) {
    log(`Error: ${ENV_FILE} not found`, "red");
    log("Copy .env.local.example to .env.local and fill in the values.", "red");
    process.exit(1);
  }

  const envContent = await Bun.file(ENV_FILE).text();
  const env: Record<string, string> = {};

  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex);
    let value = trimmed.slice(eqIndex + 1);

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
    process.env[key] = value;
  }

  // 2. Validate required env vars
  const missingVars = REQUIRED_ENV_VARS.filter((v) => !env[v]);
  if (missingVars.length > 0) {
    log(
      `Error: Missing environment variables:\n  ${missingVars.join("\n  ")}`,
      "red"
    );
    process.exit(1);
  }
  log("  All required environment variables set", "green");

  // 3. Check for uncommitted changes
  log("\nChecking git status...", "yellow");
  $.cwd(PROJECT_ROOT);
  const status = await $`git status --porcelain`.text();
  if (status.trim()) {
    log(
      "Error: Uncommitted changes detected. Commit or stash them first.",
      "red"
    );
    process.exit(1);
  }
  log("  Working directory clean", "green");

  // 4. Read current version and bump
  const configContent = await readFile(TAURI_CONFIG_PATH, "utf-8");
  const config = JSON.parse(configContent);
  const currentVersion = config.version;
  const newVersion = bumpVersion(currentVersion, bumpType);

  log(`\nBumping version: ${currentVersion} -> ${newVersion}`, "yellow");

  // 5. Update version in all files
  // tauri.conf.json
  config.version = newVersion;
  await writeFile(TAURI_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");

  // package.json
  const pkgContent = await readFile(PACKAGE_JSON_PATH, "utf-8");
  const pkg = JSON.parse(pkgContent);
  pkg.version = newVersion;
  await writeFile(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + "\n");

  // Cargo.toml — replace the version line in [package] section
  const cargoContent = await readFile(CARGO_TOML_PATH, "utf-8");
  const updatedCargo = cargoContent.replace(
    /^version = ".*"/m,
    `version = "${newVersion}"`
  );
  await writeFile(CARGO_TOML_PATH, updatedCargo);

  // 6. Commit version bump (Cargo.lock will be updated by the build, but we need
  //    to update it now so the commit includes it)
  log("\nCommitting version bump...", "yellow");
  await $`cargo generate-lockfile`.cwd(join(PROJECT_ROOT, "src-tauri"));
  await $`git add ${TAURI_CONFIG_PATH} ${PACKAGE_JSON_PATH} ${CARGO_TOML_PATH} ${CARGO_LOCK_PATH}`;
  await $`git commit -m ${"chore: bump version to " + newVersion}`;
  log("  Version bumped and committed", "green");

  // 7. Setup keychain and build
  try {
    await setupKeychain(env);

    // 8. Build
    log("\nBuilding Tauri app (aarch64-apple-darwin)...", "yellow");
    log("This may take a few minutes...\n", "yellow");

    const buildProcess = Bun.spawn(
      ["bun", "run", "tauri", "build", "--target", "aarch64-apple-darwin"],
      {
        cwd: PROJECT_ROOT,
        stdout: "inherit",
        stderr: "inherit",
        env: {
          ...process.env,
          CMAKE_POLICY_VERSION_MINIMUM: "3.5",
        },
      }
    );

    const buildExitCode = await buildProcess.exited;
    if (buildExitCode !== 0) {
      log("Error: Build failed", "red");
      process.exit(1);
    }
    log("\n  Build completed", "green");

    // 9. Find artifacts
    log("\nFinding build artifacts...", "yellow");
    const artifacts = await findArtifacts();
    log(`  DMG: ${artifacts.dmg}`, "green");
    log(`  TAR: ${artifacts.tar}`, "green");
    log(`  SIG: ${artifacts.sig}`, "green");

    // 10. Upload to Supabase Storage
    const supabaseUrl = env.SUPABASE_URL;
    const serviceKey = env.SUPABASE_SERVICE_KEY;

    log("\nUploading artifacts to Supabase Storage...", "yellow");

    // Create latest DMG alias
    const latestDmgPath = join(BUNDLE_DIR, "dmg", "Katib_latest.dmg");
    await copyFile(artifacts.dmg, latestDmgPath);

    const uploadResults = await Promise.all([
      uploadFile(artifacts.dmg, supabaseUrl, serviceKey),
      uploadFile(artifacts.tar, supabaseUrl, serviceKey),
      uploadFile(artifacts.sig, supabaseUrl, serviceKey),
      uploadFile(latestDmgPath, supabaseUrl, serviceKey),
    ]);

    if (uploadResults.some((r) => !r)) {
      log("Error: Some uploads failed", "red");
      process.exit(1);
    }

    // 11. Generate and upload latest.json
    log("\nGenerating latest.json...", "yellow");

    const tarName = basename(artifacts.tar);
    const macosSig = await Bun.file(artifacts.sig).text();
    const pubDate = new Date().toISOString();

    const latestJson = {
      version: newVersion,
      notes: `Katib v${newVersion}`,
      pub_date: pubDate,
      platforms: {
        "darwin-aarch64": {
          signature: macosSig.trim(),
          url: `${supabaseUrl}/storage/v1/object/public/${BUCKET}/${tarName}`,
        },
      },
    };

    const latestJsonPath = "/tmp/latest.json";
    await Bun.write(latestJsonPath, JSON.stringify(latestJson, null, 2));
    log("  Generated latest.json:", "green");
    console.log(JSON.stringify(latestJson, null, 2));

    await uploadFile(latestJsonPath, supabaseUrl, serviceKey);

    // 12. Create git tag
    log(`\nCreating tag v${newVersion}...`, "yellow");
    await $`git tag v${newVersion}`;
    log(`  Created tag v${newVersion}`, "green");

    // 13. Push commit + tag
    log("\nPushing to GitHub...", "yellow");
    await $`git push origin main`;
    await $`git push origin v${newVersion}`;
    log("  Pushed commit and tag", "green");

    // Done
    const dmgName = basename(artifacts.dmg);
    log(
      `
Release v${newVersion} completed!

Artifacts uploaded:
  - ${supabaseUrl}/storage/v1/object/public/${BUCKET}/${dmgName}
  - ${supabaseUrl}/storage/v1/object/public/${BUCKET}/${tarName}
  - ${supabaseUrl}/storage/v1/object/public/${BUCKET}/Katib_latest.dmg
  - ${supabaseUrl}/storage/v1/object/public/${BUCKET}/latest.json
`,
      "green"
    );
  } finally {
    await cleanupKeychain();
  }
}

main().catch((error) => {
  log(`Release failed: ${error.message}`, "red");
  cleanupKeychain().finally(() => process.exit(1));
});
