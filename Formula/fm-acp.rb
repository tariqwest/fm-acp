class FmAcp < Formula
  desc "ACP stdio adapter for Apple Foundation Models (Terminal-hosted fm serve + PCC)"
  homepage "https://github.com/tariqwest/fm-acp"
  url "https://github.com/tariqwest/fm-acp/releases/download/v0.1.1/fm-acp-prebuilt-0.1.1.tar.gz"
  sha256 "71672967ad53a83b25951b2b0faf80d1b856161a18cc6663fe161757751671aa"
  license "MIT"

  depends_on "bun"
  depends_on "cua-driver"
  depends_on :macos
  depends_on "node"

  def install
    libexec.install Dir["*"]

    (bin/"fm-acp").write <<~EOS
      #!/bin/bash
      set -euo pipefail
      export FM_ACP_SKIP_CUA_DRIVER_POSTINSTALL="${FM_ACP_SKIP_CUA_DRIVER_POSTINSTALL:-1}"
      export PATH="#{formula_opt_bin("cua-driver")}:#{formula_opt_bin("bun")}:#{formula_opt_bin("node")}:${PATH}"
      export FM_ACP_RUNTIME="${FM_ACP_RUNTIME:-bun}"
      exec "#{formula_opt_bin("node")}/node" "#{libexec}/bin/fm-acp.mjs" "$@"
    EOS
    chmod 0755, bin/"fm-acp"

    (bin/"fm-acp-terminal-helper").write <<~EOS
      #!/bin/bash
      set -euo pipefail
      export PATH="#{formula_opt_bin("bun")}:#{formula_opt_bin("node")}:${PATH}"
      if command -v bun >/dev/null 2>&1 && [ "${FM_ACP_RUNTIME:-bun}" != "node" ]; then
        exec bun "#{libexec}/bin/fm-acp-terminal-helper.mjs" "$@"
      fi
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

      Runtime:
        - Preferred: Bun
        - Fallback / npm-npx: Node + tsx (FM_ACP_RUNTIME=node)

      PCC happy path (default):
        fm-acp auto-starts Terminal-hosted `fm serve` via cua-driver.
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
