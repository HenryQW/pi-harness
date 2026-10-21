# `@henryqw/pi-advisor`

Let a second model examine the tool calls and results of each agent run before Pi settles the run. The advisor returns graded notes. A blocker makes the agent continue one time to fix it.

## Install

```bash
pi install npm:@henryqw/pi-advisor
```

The advisor uses the `pi-advisor/review` Model Task. Its default Task Profile is `balanced`. Run `/task-models` to configure a route for that profile before you turn the advisor on.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-goal`](https://pi.henry.wang/extensions/pi-goal) | Improves | Goal continuations run first. The advisor examines the run when no other continuation applies. |
| [`@henryqw/pi-task-models`](https://pi.henry.wang/extensions/pi-task-models) | Required | Provides the advisor model route. |

## Use

Run `/advisor on`. Then send a prompt that makes the agent use tools. When the run completes, Pi shows the advisor result before the run settles.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/advisor on` | command | Turn the advisor on for this conversation branch. |
| `/advisor off` | command | Turn the advisor off for this conversation branch. |
| `/advisor status` | command | Show whether the advisor is on for this conversation branch. |
| `Advisor reviewing…` | ui | Footer status while the review runs. |

The advisor is off by default.

### Results

| Reply | What Pi shows | Continuation |
| --- | --- | --- |
| `PASS` | The `Advisor: PASS` notice. | No |
| Only `nit` notes | One notice with all notes. | No |
| A `concern` note | One warning with all notes. | No |
| A `blocker` note | One warning with all notes. | One time for each user prompt |
| Malformed reply | One warning, one time in each session. | No |

## Flow

1. The agent completes a run.
2. Pi Advisor does no review when another extension already continues the run. It also does no review for a run without tool calls, an incomplete run, or a session without UI.
3. Pi Advisor sends one tool-free request to the advisor model. The request contains the latest user prompt and the run record: custom messages, assistant text, tool calls, and tool results.
4. Pi shows the notes. For a `blocker` note, Pi Advisor adds a visible `pi-advisor-blocker` message. The agent then continues in the same run.
5. After the next stop, the advisor examines the run again. It shows the notes, but it does not continue again until the next user prompt.

## State and storage

Pi Advisor keeps no files. `/advisor on` and `/advisor off` append a `pi-advisor` custom entry to the conversation. The latest entry on the current branch sets the state, so branch navigation, `/tree`, forks, and rewinds show the state of the selected branch.

Each blocker continuation is a visible `pi-advisor-blocker` message on the branch. Its `details` contain the notes.

## Limits and recovery

| Limit | Behavior | Recovery |
| --- | --- | --- |
| Interactive only | The advisor does not run in print mode or other modes without UI. | Examine the run manually. |
| No route | Pi shows a warning that names `/task-models`. The advisor does not use the session model. | Run `/task-models` and set a route for the `pi-advisor/review` profile. |
| Time limit | The review stops after 90 seconds and Pi shows a warning. The run settles without notes. | Send the next prompt. |
| Abort | During the review, Escape does not stop the advisor request. Pi stops the run after the review ends or the time limit applies. | Wait for the review or the time limit. |
| Model error | Pi shows a warning. The run settles without notes. | Run `/task-models` to examine the route, or send the next prompt. |
| Run record size | Each item is truncated to 4,000 characters, and the prompt to 8,000. The record keeps the newest 48,000 characters and marks earlier items as omitted. | Ask for a smaller run when early steps must be examined. |
| One continuation | A blocker continues the run one time for each user prompt. | Send a prompt to fix the remaining blockers. |
| Advice only | The advisor sees only the run record. Its notes can be wrong. | Examine each note before you accept it. |
