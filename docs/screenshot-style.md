# Screenshot style

Use this guide for the product screenshot in an extension README.

## Standard

Each screenshot is `example.png` in the package root, linked as `./example.png`, and listed in the package `files`.

- The image is 2080 × 1240 pixels: a 1040 × 620 canvas at 2× scale.
- The canvas shows one Pi terminal of 100 columns × 24 rows in fullscreen mode, centered on the blue gradient frame.
- The terminal uses Geist Mono at 15 px with 20 px rows. Glyphs that Geist Mono does not have fall back to the system font in the same cell width.
- Pi runs with the maintainer's normal settings in a clean clone of this repository on `main`, so the footer shows `pi-harness · main`.

Do not crop, scale, or resize the terminal for one extension. All screenshots must have the same size and text scale.

## Fill the window

The feature must be the focus, but the window must not look empty. When the feature uses only a few rows, add one real exchange before it that is related to the feature, for example a short question whose answer stays visible above the notes widget. Do not edit the captured screen or type fake output.

Use real data only. Do not show personal paths, customer data, credentials, or temporary directories. Put fixture directories at a short path such as `~/Git/<name>`, and remove them after the capture.

## Capture

`scripts/screenshots/record.py` runs Pi in a 100 × 24 pseudo-terminal, sends scripted input, and saves the raw terminal output. `scripts/screenshots/render.mjs` replays that output in a terminal emulator and writes the framed PNG with headless Google Chrome. Set `CHROME` when Chrome is not at the default macOS path.

```bash
git clone --branch main https://github.com/HenryQW/pi-harness.git /path/to/demo/pi-harness
cd /path/to/demo/pi-harness
python3 /path/to/repo/scripts/screenshots/record.py /tmp/notes.bin \
  '[["until","pi-harness",30],["send","/note Run docs:validate before you push\r"],["sleep",2]]' \
  -- pi --no-session --approve
node /path/to/repo/scripts/screenshots/render.mjs /tmp/notes.bin /path/to/repo/extensions/pi-notes/example.png
```

`record.py` steps are `["until", text, seconds]`, `["send", keys]`, and `["sleep", seconds]`. `render.mjs` also prints the captured screen as text, so you can examine it before you look at the image.

Pi Subagent needs a Herdr pane. Run `record.py` from a temporary Herdr workspace, and close that workspace after the capture to stop the workers.
