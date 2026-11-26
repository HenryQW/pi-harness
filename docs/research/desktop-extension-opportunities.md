# Desktop features worth adding to Pi

A worktree preview addresses links that expire during review. An existing session shell service may already meet that need. The smaller extension change is to combine background command results before they wake the model.

## A live preview for each worktree

On November 24, Pi posted a working Tailscale preview of a price table. The preview server later reached its command time limit. Pi had to restore the link. During an October 30 website audit, two server timeouts forced Pi to restart the server and repeat checks. On October 29, a different site's preview could not start on port 4173. Its smoke check passed on port 4174.

**Start with the reviewer's need.** The reviewer needs a private link to the intended revision for the duration of review. The current machine has a two-hour background command limit. The earlier sessions establish the cost of expiry, but give no evidence that two hours is too short today.

**What a skill can cover.** Choose the project’s development command, start the server through an approved process owner, verify the intended page, then share the Tailscale link. The process owner determines how long the server runs. With a session-scoped owner, the server can stay up until Pi closes.

**When an extension would help.** If the reviewer needs a live link inside Pi, the extension can connect process events to the interface. It can mark the link offline as soon as the server exits while the agent is idle. The following table describes that optional extension.

| Event | What the user sees |
| --- | --- |
| Start | Pi runs the project's configured development command for this worktree. A second Start returns the existing preview. |
| Port in use | For a server that accepts a port, Pi supplies an available one. A server that requires a fixed port reports the conflict. |
| Page ready | Pi shows the Tailscale link after the intended page responds on the owned server. Two worktrees can show different revisions simultaneously. |
| Process exits | The panel shows the exit reason and withdraws the live link. Restart acts on the same worktree. |
| Review ends | Stop or session shutdown stops the owned process tree. Opening another worktree leaves its preview alone. |

Claude Desktop directly supports named development servers, start and stop controls, and automatic port selection. Codex pairs a project start action with its local browser. Pi can borrow the server controls and keep the browser the user already uses. [Claude preview configuration](https://code.claude.com/docs/en/desktop#configure-preview-servers) · [Codex browser](https://developers.openai.com/codex/browser)

**What `pi-shelld` provides.** The third-party Pi extension `@yceachan/pi-shelld` version `0.3.0` runs long-lived shells for one Pi session. The `shell_daemon` tool starts and inspects them. The `/shelld` terminal monitor shows output and clickable links and lets the user stop a shell. Session shutdown stops tracked processes. The integration method `start` returns a `settled` promise with the exit status. The integration can await it to update a link without waking the model. [Pi package](https://pi.dev/packages/@yceachan/pi-shelld) · [Source and usage](https://github.com/yceachan/ea-pi-extensions/tree/95721a2b90b7c4d169762da493d47e8f23d7d6d6/packages/pi-shelld) · [Service methods](https://github.com/yceachan/ea-pi-extensions/blob/95721a2b90b7c4d169762da493d47e8f23d7d6d6/packages/pi-shelld/src/index.ts#L21-L40)

**Integration limit.** A process can be running before its webpage is ready, and a link printed in a log can point to localhost. A preview workflow must check the intended page and private address. Herdr also guards writes and worktree removal. Compatibility with those protections needs a separate check before using this service with Herdr. [Current runner](../../extensions/pi-herdr-tools/internal/command-runner.ts)

**Local process check.** A test on macOS started two temporary websites through the published version’s `startShell` implementation. Each served the expected revision on a different loopback port. Closing the first stopped its page and left the second reachable. Calling `shutdownShells` stopped the second. The sites chose their own available ports. This check covered process ownership and cleanup. It did not exercise the Pi monitor, Herdr worktree removal, or Tailscale access from another device.

**Acceptance check for a preview feature.** Start two worktrees that prefer the same port. Verify that each private link serves its own revision. Stop one and verify that only its link disappears. A preview under active review must remain available past the ordinary command deadline.

## One model turn for pending command results

On November 24, a desktop session produced separate replies explaining three obsolete relay notices. On October 30, a website audit produced separate replies explaining three earlier preview-server outcomes. In the November 24 price-table session, Pi explicitly distinguished an old cancellation from a current timeout that required recovery. That distinction matters when deciding which results should wake the agent.

**Proposed change to `pi-herdr-tools`.** When the launch branch becomes idle, collect all eligible, undelivered terminal results. Deliver them in one message and request one model turn. Include each command's identity, final state, and output link. Leave an isolated failure eligible immediately. Keep the existing branch and completion-proof checks, and record delivery for each job only once its message appears in session history. An interrupted delivery must remain recoverable.

Today the completion loop requests a model turn inside the per-job loop. The proposed change handles multiple different jobs ready together. Jobs that finish in separate idle periods can still need separate turns. Codex and Claude Desktop expose controls for when completion needs the user's attention. The Pi change applies that idea to model wake-ups. [Delivery loop](../../extensions/pi-herdr-tools/internal/commands.ts) · [Current delivery behavior](../../extensions/pi-herdr-tools/README.md#flow) · [Codex notifications](https://developers.openai.com/codex/notifications) · [Claude Desktop notifications](https://code.claude.com/docs/en/desktop#get-notified-when-a-session-finishes)

**Acceptance check.** Finish two cancellations and one failure while Pi is busy. At the next idle point, require one turn containing all three results. Reload the launch branch and require zero duplicate turns.

## Session evidence

The initial sample covered ten recent Pi sessions across projects, with one indexing item pending. Targeted searches found four sessions relevant to these proposals.

| Date | Observation |
| --- | --- |
| November 24 | A price-table preview expired during review. Its cancellation and timeout required different responses. |
| November 24 | Three obsolete relay completions prompted separate assistant replies. |
| October 30 | Two preview servers timed out during a website audit. The session also received separate replies about three earlier outcomes. |
| October 29 | A preview failed on port 4173 and passed its smoke check on port 4174. |

This research checked historical sessions, repository code, product documentation, and the shell service’s process lifecycle. It did not run the proposed Pi preview interface or the two desktop applications. Turn savings from command batching depend on which results are ready together.
