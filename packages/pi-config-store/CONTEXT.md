# Pi Config Store

Pi Config Store gives extension owners a safe configuration boundary. The shared store owns validation and file operations; each extension owns its settings, defaults, and recovery rules.

## Language

**Extension Config Home**:
The single directory owned by an extension under Pi's agent config directory. Other packages use the owner's API or events, not direct access to its files.

**Default config**:
The user-edited `config.json` in an Extension Config Home, distinct from generated state and custom-format files.

**Config issue**:
A reported problem with a config file, key, or value. A safe default or dropped invalid entry does not make the issue silent.

**Disabled config**:
A load result without usable effective settings because a required or safety-sensitive value cannot be accepted. Config repair remains available.

**Near-miss key**:
An unknown field name close enough to an absent declared field name to be treated as an invalid value for that field, rather than a harmless extra key.

**Confirmed replacement**:
An explicit replacement based on a previously read config snapshot, permitted only when the file remains unchanged and the snapshot proves its complete contents.
