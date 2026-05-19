import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

describe("install.sh", () => {
  test("defaults to downloading proxy.js from the upstream raw URL", () => {
    const script = readFileSync(join(repoRoot, "install.sh"), "utf8");
    expect(script).toContain(
      'PROXY_JS_URL="${PROXY_JS_URL:-https://raw.githubusercontent.com/tokinx/any-proxy/refs/heads/main/proxy.js}"',
    );
  });

  test("resolve_source_proxy_js downloads proxy.js when the local file is missing", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "any-proxy-install-"));

    try {
      const fakeCurl = join(tempDir, "curl");
      writeFileSync(
        fakeCurl,
        `#!/usr/bin/env bash
set -euo pipefail
out=""
while (($#)); do
  if [[ "$1" == "-o" ]]; then
    out="$2"
    shift 2
    continue
  fi
  shift
done
printf 'downloaded-proxy' >"$out"
`,
      );
      chmodSync(fakeCurl, 0o755);

      const output = execFileSync(
        "bash",
        [
          "-lc",
          `
set -euo pipefail
PATH="${tempDir}:$PATH"
PROXY_JS_URL='https://example.com/proxy.js'
SOURCE_PROXY_JS='${join(tempDir, "missing-proxy.js")}'
TMP_PROXY_JS=''
t() { printf '%s' "$1"; }
source <(sed -n '/^resolve_source_proxy_js()/,/^}/p' install.sh)
resolved="$(resolve_source_proxy_js | tail -n 1)"
test -f "$resolved"
cat "$resolved"
`,
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );

      expect(output.trim()).toBe("downloaded-proxy");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("validate_allowlist_entry accepts IPv6 entries", () => {
    execFileSync(
      "bash",
      [
        "-lc",
        `
set -euo pipefail
source <(sed -n '/^validate_allowlist_entry()/,/^}/p' install.sh)
validate_allowlist_entry '::1'
validate_allowlist_entry '2001:db8::/64'
validate_allowlist_entry '[2001:db8::1]'
`,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
  });
});
