# `@henryqw/pi-model-thinking`

Remember the thinking level for each model and restore it when that model becomes active.

## Install

```bash
pi install npm:@henryqw/pi-model-thinking
```

## Use

| Surface | Purpose |
| --- | --- |
| `/model-thinking` | Choose the level to remember for the current model. `Use current level` clears the saved choice. |

Valid levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Applied on session start and model change. Numbered `pi-multi-codex` providers share canonical `openai-codex/model`, so account switches keep the same level.

## Config

`~/.pi/agent/config/pi-model-thinking.json`

```json
{
  "anthropic/claude-opus-4-8": "high",
  "openai-codex/gpt-5.6-luna": "minimal"
}
```

Missing config starts empty. Invalid entries are skipped. Malformed files are preserved and never rewritten on startup.

## Remove

```bash
pi remove npm:@henryqw/pi-model-thinking
```

## Development

```bash
npm test --workspace @henryqw/pi-model-thinking
npm run typecheck --workspace @henryqw/pi-model-thinking
npm run pack:check --workspace @henryqw/pi-model-thinking
```
