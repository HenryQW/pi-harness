# Licence scope and source notices

This package contains files under two licences. This is not a choice of licence for each file.

- The existing pi-pr extension code, package-owned PR skills, and tests use the MIT licence in `LICENSE`.
- The imported files listed below and their modifications use Apache-2.0. `LICENSE-APACHE-2.0` is an exact copy of the original source licence. These files are not relicensed as MIT.

## Imported source

Source: Henry Wang's `HenryQW/skills` repository, <https://github.com/HenryQW/skills>.
The read-only source snapshot inspected for these notices is commit `6857c81611ab8e7aaacf4233452a0841d7df79a9`.
Each source path below is relative to that repository. Each package path is relative to this package.

| Source path | Package path | Modification notice |
| --- | --- | --- |
| `git-commit/SKILL.md` | `skills/git-commit/SKILL.md` | Modified for pi-pr: use the shared native scoped commit tool, content/index checks, and uncertain-outcome rules. |
| `git-pr/SKILL.md` | `skills/git-pr/SKILL.md` | Modified for pi-pr: replace shell publication with bounded native dispatch, explicit base intent, upstream consent, and exact PR reuse. |
| `update-from-main/SKILL.md` | `skills/update-from-main/SKILL.md` | Modified for pi-pr: packaged helper guidance, bounded check output, exact backup identity, worktree ownership, and retained-backup recovery after success or failure. |
| `update-from-main/scripts/update_from_main.py` | `skills/update-from-main/scripts/update_from_main.py` | Modified for pi-pr: add collision/race regressions, identify the backup by a unique reflog message, record its owner in per-worktree refs, and apply its exact OID without popping or dropping it. |
| `update-from-main/scripts/validate.py` | `skills/update-from-main/scripts/validate.py` | Copied validator; added the source, licence, and modification notice header. |

The source snapshot has no separate `NOTICE` file and no file-specific copyright notice in these five files. The full original Apache licence, including its appendix, is preserved unchanged. Attribution to the source author and repository is retained here. The unrelated source `agents/openai.yaml` files were not imported.

These notices do not change the existing MIT licence for the package-owned code. The package manifest uses `(MIT AND Apache-2.0)` to describe the combined distribution. This notice and both licence files are included in the packed package.
