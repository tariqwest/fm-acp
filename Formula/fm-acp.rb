class FmAcp < Formula
  desc "ACP stdio adapter for Apple Foundation Models (Terminal-hosted fm serve + PCC)"
  homepage "https://github.com/tariqwest/fm-acp"
  url "https://github.com/tariqwest/fm-acp/releases/download/v0.1.0/fm-acp-prebuilt-0.1.0.tar.gz"
  sha256 "c9ffa2fec2b242ffebbfb9cbdc348256088f6b15a1480bd0910f4643f9490f70"
  license "MIT"
  version "0.1.0"

  depends_on "node"
  depends_on "cua-driver"
  depends_on :macos

  def install
    libexec.install Dir["*"]

    (bin/"fm-acp").write <<~EOS
      #!/bin/bash
      set -euo pipefail
      export FM_ACP_SKIP_CUA_DRIVER_POSTINSTALL="${FM_ACP_SKIP_CUA_DRIVER_POSTINSTALL:-1}"
      export PATH="#{Formula["cua-driver"].opt_bin}:${PATH}"
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/bin/fm-acp.mjs" "$@"
    EOS
    chmod 0755, bin/"fm-acp"

    (bin/"fm-acp-terminal-helper").write <<~EOS
      #!/bin/bash
      set -euo pipefail
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/bin/fm-acp-terminal-helper.mjs" "$@"
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
