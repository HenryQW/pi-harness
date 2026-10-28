// Render the final screen of a record.py capture into the standard framed PNG.
// usage: node scripts/screenshots/render.mjs CAPTURE OUT.png
// Set CHROME when Google Chrome is not at the default macOS path.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import xterm from "@xterm/headless";

const [capture, out] = process.argv.slice(2);
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const COLS = 100, ROWS = 24, CELL = 9, FG = "#fcfcfa", BG = "#2d2a2e";
// Ghostty default 16-colour palette; 16-255 follow the xterm cube and grey ramp.
const BASE = ["#1d1f21", "#cc6666", "#b5bd68", "#f0c674", "#81a2be", "#b294bb", "#8abeb7", "#c5c8c6",
  "#666666", "#d54e53", "#b9ca4a", "#e7c547", "#7aa6da", "#c397d8", "#70c0b1", "#eaeaea"];
const hex = (n) => n.toString(16).padStart(2, "0");
const palette = (i) => {
  if (i < 16) return BASE[i];
  if (i < 232) {
    const v = [0, 95, 135, 175, 215, 255], c = i - 16;
    return `#${hex(v[Math.floor(c / 36)])}${hex(v[Math.floor(c / 6) % 6])}${hex(v[c % 6])}`;
  }
  return `#${hex(8 + (i - 232) * 10).repeat(3)}`;
};
const color = (cell, fg) => {
  const v = fg ? cell.getFgColor() : cell.getBgColor();
  if (fg ? cell.isFgRGB() : cell.isBgRGB()) return `#${v.toString(16).padStart(6, "0")}`;
  if (fg ? cell.isFgPalette() : cell.isBgPalette()) return palette(v);
  return undefined;
};
const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

const term = new xterm.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
term.loadAddon(new Unicode11Addon());
term.unicode.activeVersion = "11";
await new Promise((resolve) => term.write(readFileSync(capture), resolve));

const buffer = term.buffer.active, cell = buffer.getNullCell();
let rows = "";
for (let y = 0; y < ROWS; y++) {
  const line = buffer.getLine(buffer.viewportY + y);
  console.log(String(y).padStart(2), `|${line.translateToString(true)}`);
  rows += '<div class="r">';
  for (let x = 0; x < COLS; x++) {
    line.getCell(x, cell);
    const width = cell.getWidth();
    if (width === 0) continue;
    let fg = color(cell, true) ?? FG, bg = color(cell, false);
    if (cell.isInverse()) [fg, bg] = [bg ?? BG, fg];
    const ch = cell.getChars() || " ";
    // Fixed pixel cells keep columns aligned when a glyph falls back to another font.
    const style = [`color:${fg}`, bg && `background:${bg}`, `width:${width * CELL}px`,
      cell.isBold() && "font-weight:600", cell.isItalic() && "font-style:italic", cell.isDim() && "opacity:.6",
      cell.isUnderline() && "text-decoration:underline", /\p{Extended_Pictographic}/u.test(ch) && "font-size:13px"];
    rows += `<span style="${style.filter(Boolean).join(";")}">${escape(ch)}</span>`;
  }
  rows += "</div>";
}

const font = `data:font/woff2;base64,${readFileSync(new URL("../../node_modules/@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2", import.meta.url)).toString("base64")}`;
const html = `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:"Geist Mono";src:url("${font}") format("woff2");font-weight:100 900}
html,body{margin:0}
body{width:1040px;height:620px;display:grid;place-items:center;
  background:radial-gradient(120% 140% at 0% 0%,#8fd0e6 0%,#2a7fae 28%,#0b3a6e 55%,#0a2550 72%,#2b86b0 100%)}
.w{background:${BG};border-radius:10px;padding:18px;box-shadow:0 18px 50px rgba(3,15,40,.45),0 0 0 1px rgba(255,255,255,.06)}
.r{display:flex;height:20px;font:15px/20px "Geist Mono",Menlo,"Apple Symbols",monospace;white-space:pre}
.r span{display:inline-block;text-align:center}
</style><div class="w">${rows}</div>`;
const page = join(mkdtempSync(join(tmpdir(), "pi-screenshot-")), "page.html");
writeFileSync(page, html);
execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2", "--window-size=1040,620",
  "--virtual-time-budget=8000", `--screenshot=${resolve(out)}`, `file://${page}`], { stdio: "ignore" });
