# Pi Add Dir

Pi Add Dir brings external instructions, Skills, and file search into a Pi session without changing its working directory.

## Language

**External directory**:
A directory outside the current Pi working directory that is added to the session.
_Avoid_: Project root, current working directory

**External context**:
The instructions from an external directory's `AGENTS.md` and `CLAUDE.md` files, at its root or in `.pi/`, included in Pi's system context.
_Avoid_: File search result, session transcript

**External skill**:
A Skill found under an external directory and made available to Pi by name.
_Avoid_: Local skill, prompt text

**Directory scope**:
The lifetime and reach of a directory addition: the current session branch, the local repository and its worktrees, or all workspaces.
