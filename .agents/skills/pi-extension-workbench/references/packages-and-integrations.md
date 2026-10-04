# Packages and Integrations

Read installed `docs/packages.md` for manifest/discovery/dependency contracts.
Inspect the manifest owning the extension entry point, not just workspace root;
check its lockfile, scripts, and documented support policy.

## Compatibility and packaging

- Record installed Pi's `package.json` version. Verify any explicitly supported
  minimum against target types/tests or version-matched published material before
  using newer APIs. A host peer range `"*"` declares no minimum; do not interpret
  it as a promise to support all historical versions or invent a floor.
- Use manifest `pi.extensions`, `skills`, `prompts`, and `themes` for static
  resources. Conventional directories work without a manifest; `pi-package` is
  gallery discovery, not a loading requirement. See installed `docs/packages.md`.
- Runtime third-party libraries belong in `dependencies`. Host-provided
  `@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui` (all under
  `@earendil-works/`), and `typebox` belong in wildcard `peerDependencies`, not
  bundled copies. Duplicate host packages can bypass module mapping.
- Other Pi package dependencies need published files and explicit resource paths
  under `node_modules/`. Check packaging rather than assuming bundling; use
  `npm pack --dry-run --ignore-scripts` to inspect contents without lifecycle
  hooks. Do not create release tarballs or publish unless requested.
- Use `resources_discover` only for computed paths. Resolve siblings with
  `import.meta.url`, not cwd. See `examples/extensions/dynamic-resources/index.ts`.

## Prefer native integrations

| Need | Native API | Installed reference |
|---|---|---|
| Call existing tools | `ctx.executeTool()` | `docs/extensions.md`: Tools |
| Register session MCP servers | `registerMcpServer` / `unregisterMcpServer` | `docs/extensions.md`: MCP servers; `docs/mcp.md` |
| Route requests across models | `registerVirtualModel` | `docs/virtual-models.md` |
| Proxy/auth/catalog or custom streaming | `registerProvider` | `docs/custom-provider.md` |
| Observe/adjust provider HTTP traffic | Provider request/headers/response events | `examples/extensions/provider-payload.ts` |

Do not build a custom MCP client or provider for ordinary server registration,
model selection, or model routing. MCP registrations are session/runtime-local;
register again on load and honor configured server overrides. Pass cancellation
to network I/O. Never log credentials, auth headers, or provider secrets.
Extensions execute with user permissions: preserve project trust checks and
validate external configuration, paths, and payloads at their boundary.

## Isolated smoke load

Inspect extension startup code first. Isolation below removes ambient resources
and Pi startup networking; it is not a sandbox and cannot stop extension code
from accessing files, credentials, or the network. Skip unsafe side effects and
report the untested path. Verify flags with installed `pi --help` when they differ.

Set `EXTENSION` to the absolute inspected entry point. Run this in one shell call:

```bash
EXTENSION=/absolute/path/to/extension.ts
probe="$(mktemp -d)"
trap 'rm -rf "$probe"' EXIT
(
  cd "$probe" || exit
  printf '%s\n' '{"id":"smoke","type":"get_state"}' |
    PI_CODING_AGENT_DIR="$probe/agent" pi --offline --mode rpc --no-session \
      --no-extensions --no-skills --no-prompt-templates --no-themes \
      --no-context-files --no-approve --extension "$EXTENSION" \
      >stdout.jsonl 2>stderr.log
) || { head -c 8192 "$probe/stderr.log"; exit 1; }
python3 - "$probe/stdout.jsonl" <<'PY' || exit 1
import json, sys
with open(sys.argv[1]) as output:
    records = [json.loads(line) for line in output]
assert not any(r.get("type") == "extension_error" for r in records), "Extension handler failed"
assert any(r.get("id") == "smoke" and r.get("success") for r in records), "No successful get_state response"
print("RPC startup/state/shutdown passed; no model request")
PY
head -c 8192 "$probe/stderr.log"
```

Apply a tool timeout; inspect stderr for load errors even after a successful
state response (Pi can continue after rejecting an extension). Stdin EOF requests
orderly runtime disposal; do not send a prompt. For lifecycle changes, verify the
expected startup/cleanup effects, not just process exit. This does not test
reload, tree/fork restoration, cancellation, or TUI/JSON/print behavior: run the
smallest affected checks separately. See installed `docs/rpc.md`.
