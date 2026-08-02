#!/usr/bin/env node
/**
 * Build a Homebrew-ready prebuilt tarball, create/update a GitHub release,
 * generate Formula/fm-acp.rb (+ Formula/cua-driver.rb), and push to
 * tariqwest/homebrew-tap.
 *
 * Usage:
 *   node scripts/homebrew-release.mjs [--dry-run] [--skip-release] [--skip-tap-push] [--tap-path PATH]
 *
 * Env:
 *   FM_ACP_TAP_PATH   override tap checkout
 *   FM_ACP_VERSION    override version (default: package.json version)
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const argv = process.argv.slice(2);
const args = new Set(argv);
const dryRun = args.has("--dry-run");
const skipRelease = args.has("--skip-release");
const skipTapPush = args.has("--skip-tap-push") || dryRun;
const tapPathArgIdx = argv.indexOf("--tap-path");
const tapPathOverride =
  tapPathArgIdx >= 0 ? argv[tapPathArgIdx + 1] : process.env.FM_ACP_TAP_PATH;

const version = process.env.FM_ACP_VERSION?.trim() || pkg.version;
const tag = `v${version}`;
const ownerRepo = "tariqwest/fm-acp";
const assetName = `fm-acp-prebuilt-${version}.tar.gz`;

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    encoding: "utf8",
    stdio: opts.stdio ?? "pipe",
    cwd: opts.cwd ?? root,
    env: { ...process.env, ...(opts.env || {}) },
  });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || "").trim();
    throw new Error(`${cmd} ${cmdArgs.join(" ")} failed (${r.status}): ${err}`);
  }
  return (r.stdout || "").trim();
}

function sha256File(filePath) {
  const h = createHash("sha256");
  h.update(readFileSync(filePath));
  return h.digest("hex");
}

function detectTapPath() {
  if (tapPathOverride && existsSync(tapPathOverride)) return path.resolve(tapPathOverride);
  const candidates = [
    path.join(os.homedir(), "homebrew-tap"),
    path.join(os.homedir(), "Developer", "homebrew-tap"),
    "/opt/homebrew/Library/Taps/tariqwest/homebrew-tap",
    "/usr/local/Homebrew/Library/Taps/tariqwest/homebrew-tap",
  ];
  for (const c of candidates) if (existsSync(path.join(c, ".git"))) return c;
  throw new Error("Could not find tariqwest/homebrew-tap checkout; pass --tap-path");
}

function buildPrebuiltTarball() {
  const stageRoot = mkdtempSync(path.join(os.tmpdir(), "fm-acp-brew-"));
  const stage = path.join(stageRoot, `fm-acp-${version}`);
  mkdirSync(stage, { recursive: true });

  for (const rel of [
    "bin",
    "src",
    "scripts",
    "package.json",
    "pnpm-lock.yaml",
    "LICENSE",
    "README.md",
    "AGENTS.md",
  ]) {
    const src = path.join(root, rel);
    if (!existsSync(src)) continue;
    cpSync(src, path.join(stage, rel), {
      recursive: true,
      filter: (p) =>
        !p.includes(`${path.sep}node_modules${path.sep}`) && !p.endsWith(".test.ts"),
    });
  }

  const hasPnpm = spawnSync("pnpm", ["--version"], { encoding: "utf8" }).status === 0;
  const installEnv = {
    ...process.env,
    FM_ACP_SKIP_CUA_DRIVER_POSTINSTALL: "1",
  };
  if (hasPnpm) {
    run("pnpm", ["install", "--prod", "--frozen-lockfile", "--ignore-scripts"], {
      cwd: stage,
      stdio: "inherit",
      env: installEnv,
    });
  } else {
    run("npm", ["install", "--omit=dev", "--ignore-scripts"], {
      cwd: stage,
      stdio: "inherit",
      env: installEnv,
    });
  }

  const walkDelete = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walkDelete(p);
      else if (name.endsWith(".test.ts")) rmSync(p);
    }
  };
  walkDelete(path.join(stage, "src"));

  const outDir = path.join(root, "dist-homebrew");
  mkdirSync(outDir, { recursive: true });
  const tarball = path.join(outDir, assetName);
  if (existsSync(tarball)) rmSync(tarball);

  run("tar", ["-czf", tarball, "-C", stageRoot, `fm-acp-${version}`], { stdio: "inherit" });
  const digest = sha256File(tarball);
  rmSync(stageRoot, { recursive: true, force: true });
  return {
    tarball,
    digest,
    url: `https://github.com/${ownerRepo}/releases/download/${tag}/${assetName}`,
  };
}

function renderFmAcpFormula({ version, url, sha256 }) {
  return `class FmAcp < Formula
  desc "ACP stdio adapter for Apple Foundation Models (Terminal-hosted fm serve + PCC)"
  homepage "https://github.com/${ownerRepo}"
  version "${version}"
  url "${url}"
  sha256 "${sha256}"
  license "MIT"

  depends_on :macos
  depends_on "cua-driver"
  depends_on "node"

  def install
    libexec.install Dir["*"]

    (bin/"fm-acp").write <<~EOS
      #!/bin/bash
      set -euo pipefail
      export FM_ACP_SKIP_CUA_DRIVER_POSTINSTALL="\${FM_ACP_SKIP_CUA_DRIVER_POSTINSTALL:-1}"
      export PATH="#{formula_opt_bin("cua-driver")}:\${PATH}"
      exec "#{formula_opt_bin("node")}/node" "#{libexec}/bin/fm-acp.mjs" "$@"
    EOS
    chmod 0755, bin/"fm-acp"

    (bin/"fm-acp-terminal-helper").write <<~EOS
      #!/bin/bash
      set -euo pipefail
      exec "#{formula_opt_bin("node")}/node" "#{libexec}/bin/fm-acp-terminal-helper.mjs" "$@"
    EOS
    chmod 0755, bin/"fm-acp-terminal-helper"
  end

  def caveats
    <<~EOS
      fm-acp requires:
        - macOS 26+ (27+ for system fm / PCC)
        - Apple Silicon with Apple Intelligence enabled
        - /usr/bin/fm (system) and/or afm on PATH

      PCC happy path (default):
        fm-acp auto-starts Terminal-hosted \`fm serve\` via cua-driver.
        Grant Accessibility/Screen Recording to CuaDriver if prompted:
          cua-driver permissions grant

      Disable auto-serve:
        export FM_ACP_AUTO_SERVE=0

      Manual serve:
        fm serve --socket ~/.config/fm-acp/fm.sock
    EOS
  end

  test do
    assert_path_exists bin/"fm-acp"
    assert_path_exists bin/"fm-acp-terminal-helper"
    assert_match "#!/bin/bash", (bin/"fm-acp").read
  end
end
`;
}

function renderCuaDriverFormula({ version, url, sha256, tagName }) {
  return `class CuaDriver < Formula
  desc "Background computer-use driver CLI + app (Cua) for macOS automation"
  homepage "https://cua.ai/cua-driver"
  version "${version}"
  url "${url}"
  sha256 "${sha256}"
  license "MIT"

  livecheck do
    url "https://github.com/trycua/cua/releases"
    regex(/href=.*?cua-driver-rs-v?(\\d+(?:\\.\\d+)+)/i)
  end

  depends_on :macos

  def install
    # Staged tarball contains CLI binaries + CuaDriver.app (TCC identity).
    prefix.install "CuaDriver.app" if (buildpath/"CuaDriver.app").exist?

    # Keep supporting libs next to a stable libexec root.
    libexec.install Dir["*"]

    if (prefix/"CuaDriver.app").exist?
      (bin/"cua-driver").write <<~EOS
        #!/bin/bash
        set -euo pipefail
        exec "#{prefix}/CuaDriver.app/Contents/MacOS/cua-driver" "$@"
      EOS
    elsif (libexec/"cua-driver").exist?
      (bin/"cua-driver").write <<~EOS
        #!/bin/bash
        set -euo pipefail
        exec "#{libexec}/cua-driver" "$@"
      EOS
    else
      odie "cua-driver binary not found in release archive"
    end
    chmod 0755, bin/"cua-driver"
  end

  def caveats
    <<~EOS
      Cua Driver needs Accessibility and Screen Recording grants.

      Start the app daemon (recommended before granting permissions):
        open -n -g -a "#{prefix}/CuaDriver.app" --args serve

      Then:
        cua-driver permissions grant
        cua-driver permissions status
        cua-driver doctor

      Upstream install docs:
        https://cua.ai/docs/cua-driver/guide/getting-started/installation

      Formula source tag: ${tagName}
    EOS
  end

  test do
    assert_match(/\\d+\\.\\d+/, shell_output("#{bin}/cua-driver --version"))
  end
end
`;
}

function fetchLatestCuaDriver() {
  const raw = run("gh", [
    "api",
    "repos/trycua/cua/releases",
    "--jq",
    "[.[] | select(.tag_name | test(\"^cua-driver-rs-v\"))][0] | {tag_name, assets}",
  ]);
  const rel = JSON.parse(raw);
  const tagName = rel.tag_name;
  const ver = tagName.replace(/^cua-driver-rs-v/, "");
  const asset = (rel.assets || []).find(
    (a) => a.name === `cua-driver-rs-${ver}-darwin-universal.tar.gz`,
  );
  if (!asset?.browser_download_url) {
    throw new Error(`No darwin-universal tarball on ${tagName}`);
  }
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cua-driver-brew-"));
  const tgz = path.join(tmp, asset.name);
  run("curl", ["-fsSL", "-o", tgz, asset.browser_download_url], { stdio: "inherit" });
  const digest = sha256File(tgz);
  rmSync(tmp, { recursive: true, force: true });
  return {
    tagName,
    version: ver,
    url: asset.browser_download_url,
    sha256: digest,
  };
}

function ensureRelease({ tarball }) {
  const tags = run("git", ["tag", "-l", tag]);
  if (!tags) {
    if (dryRun) {
      console.error(`[dry-run] would create+push tag ${tag}`);
    } else {
      run("git", ["tag", "-a", tag, "-m", `fm-acp ${tag}`], { stdio: "inherit" });
      run("git", ["push", "origin", tag], { stdio: "inherit" });
    }
  } else {
    console.error(`[release] tag ${tag} already exists`);
  }

  const existing = spawnSync("gh", ["release", "view", tag, "-R", ownerRepo], {
    encoding: "utf8",
  });
  if (existing.status !== 0) {
    if (dryRun) {
      console.error(`[dry-run] would create release ${tag} with ${path.basename(tarball)}`);
    } else {
      run(
        "gh",
        [
          "release",
          "create",
          tag,
          tarball,
          "-R",
          ownerRepo,
          "--title",
          `fm-acp ${tag}`,
          "--notes",
          [
            `Homebrew prebuilt release for fm-acp ${version}.`,
            "",
            "Install:",
            "",
            "```bash",
            "brew tap tariqwest/tap",
            "brew install fm-acp",
            "```",
            "",
          ].join("\n"),
        ],
        { stdio: "inherit" },
      );
    }
  } else if (dryRun) {
    console.error(`[dry-run] would upload ${path.basename(tarball)} to existing release ${tag}`);
  } else {
    run("gh", ["release", "upload", tag, tarball, "-R", ownerRepo, "--clobber"], {
      stdio: "inherit",
    });
  }
}

function writeFormulas(tapPath, fmFormula, cuaFormula) {
  const projectFormulaDir = path.join(root, "Formula");
  mkdirSync(projectFormulaDir, { recursive: true });
  writeFileSync(path.join(projectFormulaDir, "fm-acp.rb"), fmFormula);
  writeFileSync(path.join(projectFormulaDir, "cua-driver.rb"), cuaFormula);

  const formulaDir = path.join(tapPath, "Formula");
  mkdirSync(formulaDir, { recursive: true });
  const fmPath = path.join(formulaDir, "fm-acp.rb");
  const cuaPath = path.join(formulaDir, "cua-driver.rb");

  if (dryRun) {
    console.error(`[dry-run] would write tap formulas:\n  ${fmPath}\n  ${cuaPath}`);
    console.error(`[dry-run] wrote project copies under Formula/`);
    return { fmPath, cuaPath };
  }
  writeFileSync(fmPath, fmFormula);
  writeFileSync(cuaPath, cuaFormula);
  return { fmPath, cuaPath };
}

function pushTap(tapPath) {
  if (skipTapPush) {
    console.error("[tap] skip commit/push (--dry-run or --skip-tap-push)");
    return;
  }
  run("git", ["add", "Formula/fm-acp.rb", "Formula/cua-driver.rb"], {
    cwd: tapPath,
    stdio: "inherit",
  });
  const status = run("git", ["status", "--porcelain"], { cwd: tapPath });
  if (!status) {
    console.error("[tap] no changes to commit");
    return;
  }
  run(
    "git",
    ["commit", "-m", `feat: add/update fm-acp ${version} (depends on cua-driver)`],
    { cwd: tapPath, stdio: "inherit" },
  );
  run("git", ["push", "origin", "HEAD"], { cwd: tapPath, stdio: "inherit" });
}

function main() {
  console.error(`[homebrew-release] version=${version} tag=${tag} dryRun=${dryRun}`);
  const tapPath = detectTapPath();
  console.error(`[homebrew-release] tap=${tapPath}`);

  const prebuilt = buildPrebuiltTarball();
  console.error(`[homebrew-release] tarball=${prebuilt.tarball}`);
  console.error(`[homebrew-release] sha256=${prebuilt.digest}`);

  if (!skipRelease) {
    ensureRelease({ tarball: prebuilt.tarball });
  } else {
    console.error("[homebrew-release] skip GitHub release (--skip-release)");
  }

  const cua = fetchLatestCuaDriver();
  console.error(`[homebrew-release] cua-driver ${cua.version} sha256=${cua.sha256}`);

  const fmFormula = renderFmAcpFormula({
    version,
    url: prebuilt.url,
    sha256: prebuilt.digest,
  });
  const cuaFormula = renderCuaDriverFormula(cua);
  writeFormulas(tapPath, fmFormula, cuaFormula);
  pushTap(tapPath);

  console.error("[homebrew-release] done");
  console.error("  brew update");
  console.error("  brew tap tariqwest/tap");
  console.error("  brew install fm-acp");
}

main();
