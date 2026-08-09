# `@henryqw/pi-model-thinking`

Pi extension that restores chosen thinking level whenever model becomes active.

## Install

```bash
pi install npm:@henryqw/pi-model-thinking
```

Remove with:

```bash
pi remove npm:@henryqw/pi-model-thinking
```

## Use

Run `/model-thinking`, then choose level to remember for current model. Choose `Use current level` to clear saved choice.

Valid levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

Config lives in `~/.pi/agent/config/model-thinking.json`:

```json
{
  "anthropic/claude-opus-4-8": "high",
  "openai-codex/gpt-5.6-luna": "minimal"
}
```

Extension applies config when session starts or model changes. Missing config starts empty, invalid entries are skipped, and malformed config is preserved.
