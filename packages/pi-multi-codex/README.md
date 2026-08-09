# Pi Multi Codex

Use multiple ChatGPT Codex OAuth slots in Pi.

Native Pi auth remains owner of credentials. Run `/login` and select OpenAI
Codex for slot 1. Run `/codex-add`, then `/login` and select reported numbered
slot for each additional Codex OAuth credential.

Extension reads native `auth.json` and never writes or refreshes credentials.
