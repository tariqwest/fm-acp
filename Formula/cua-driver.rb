class CuaDriver < Formula
  desc "Background computer-use driver CLI + app (Cua) for macOS automation"
  homepage "https://cua.ai/cua-driver"
  url "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.16.0/cua-driver-rs-0.16.0-darwin-universal.tar.gz"
  sha256 "ed3c82643d42ac8482e77cd948227f2fb44e0f65e084ea11cc2cbca4fa8ec691"
  license "MIT"
  version "0.16.0"

  livecheck do
    url "https://github.com/trycua/cua/releases"
    regex(/href=.*?cua-driver-rs-v?(\d+(?:\.\d+)+)/i)
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

      Formula source tag: cua-driver-rs-v0.16.0
    EOS
  end

  test do
    assert_match(/\d+\.\d+/, shell_output("#{bin}/cua-driver --version"))
  end
end
