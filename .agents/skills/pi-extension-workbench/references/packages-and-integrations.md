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
  In new code, import `Type`, `Static`, and `TSchema` from `typebox`. Pi maps
  extension imports of `@earendil-works/pi-ai` to a compatibility view that still
  supplies TypeBox exports and a TypeBox-typed `StringEnum`; the standalone
  package root does not provide the same view. Do not rewrite existing extension
  imports without need; verify direct imports and typechecks outside the host.
- Other Pi package dependencies need published files and explicit resource paths
  under `node_modules/`. Check packaging rather than assuming bundling; use
  `npm pack --dry-run --ignore-scripts` to inspect contents without lifecycle
  hooks. Do not create release tarballs or publish unless requested.
- Use `resources_discover` only for computed paths. Resolve siblings with
  `import.meta.url`, not cwd. See `examples/extensions/dynamic-resources/index.ts`.
- For update notices, ship a package-root **CHANGELOG.md**, or set `pi.changelogPath` to a file
  inside the package; `""` disables notices. Pi records the version without a
  notice on first sight. Later version increases show newer entries on a fresh
  launch, not just reload, and only for packages that load an extension.
  `collapseChangelog` condenses notices; `/changelog` does not show package
  changelogs. Keep the chosen file in the published artifact.

## Prefer native integrations

| Need | Native API | Installed reference |
|---|---|---|
| Call existing tools | `ctx.executeTool()` | `docs/extensions.md`: Calling Other Tools |
| Register session Model Context Protocol (MCP) servers | `registerMcpServer` / `unregisterMcpServer` | `docs/extensions.md`: MCP Servers; `docs/mcp.md` |
| Route requests across models | `registerVirtualModel` | `docs/virtual-models.md` |
| Inspect effective model configuration / classifier image input | Model registry / `models.classify()` | `docs/models-configuration.md`; `docs/models.md`; `docs/codemode.md` |
| Proxy/auth/catalog or custom streaming | `registerProvider` | `docs/custom-provider.md` |
| Observe/adjust provider HTTP traffic | Provider request/headers/response events | `examples/extensions/provider-payload.ts` |

Do not build a custom MCP client or provider for ordinary server registration,
model selection, or model routing. MCP registrations are session/runtime-local;
register again on load and honor configured server overrides. Pass cancellation
to network input/output operations. Never log credentials, authorization headers,
or provider secrets.

Native `oauth.clientRegistration` defaults to `auto`: use a Client ID Metadata
Document when supported for public clients, else dynamic registration. A custom
`clientName` or non-default `callbackUrl` also selects registration. Explicit `dcr`
means dynamic client registration; `cimd` means Client ID Metadata Document.
Custom policy validators must accept valid native modes while preserving server
allowlists and the stricter `cimd` field constraints. See `docs/mcp.md`.

Provider attribution headers for OpenRouter, NVIDIA NIM (NVIDIA Inference
Microservices), and OpenCode no longer appear in `before_provider_headers`;
returning `null` for one still suppresses it. Do not infer absence on the wire
from absence in that event.

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
