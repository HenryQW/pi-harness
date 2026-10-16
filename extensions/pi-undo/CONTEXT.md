# Pi Undo

Pi Undo returns the conversation to the latest user prompt on the active branch so the user can edit and resend it. It does not restore files.

## Language

**Undo target**:
The latest user prompt on the current conversation branch, not a prompt on a sibling branch.

**Conversation rewind**:
Return to the Undo target after active work stops, excluding later conversation context from the resumed turn. Filesystem changes remain in place.
