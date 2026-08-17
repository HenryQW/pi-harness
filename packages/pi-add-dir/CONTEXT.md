# Pi Add Dir

**External directory**: Directory outside current Pi working directory added to active session.
_Avoid_: Project root, current working directory

**External context**: Root `AGENTS.md` / `CLAUDE.md` files from an external directory injected into Pi system context.
_Avoid_: File search result, session transcript

**External skill**: Skill found in `.pi/skills`, `.agents/skills`, or `.claude/skills` under an external directory and registered as `/skill:<name>`.
_Avoid_: Local skill, prompt text
