# Screenshot style

Use this guide for the product screenshot in an extension README.

## Standard

Each screenshot is `example.png` in the package root, linked as `./example.png`. The scripts fix the size, font, and frame; do not crop or resize the PNG.

Pi runs in fullscreen mode with the extensions of this repository installed, in a clean clone of this repository on `main`, so the footer shows `pi-harness · main`.

## Fill the window

The feature must be the focus, but the window must not look empty. When the feature uses only a few rows, add one real exchange before it that is related to the feature, for example a short question whose answer stays visible above the notes widget. Do not edit the captured screen or type fake output.

Use real data only. Do not show personal paths, customer data, credentials, or temporary directories. Put fixture directories at a short path under `~`, and remove them after the capture.

## Capture

Run `pnpm install` in this repository first: `render.mjs` uses its dev dependencies.

```bash
git clone --branch main https://github.com/HenryQW/pi-harness.git /path/to/demo/pi-harness
cd /path/to/demo/pi-harness
python3 /path/to/repo/scripts/screenshots/record.py /tmp/notes.bin \
  '[["until","pi-harness",30],["send","/note Run docs:validate before you push\r"],["sleep",2]]' \
  -- pi --no-session --approve
node /path/to/repo/scripts/screenshots/render.mjs /tmp/notes.bin /path/to/repo/extensions/pi-notes/example.png
```

Pi Subagent needs a Herdr pane. Run `record.py` from a temporary Herdr workspace, and close that workspace after the capture to stop the workers.
