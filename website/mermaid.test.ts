import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { registerMermaid } from "./mermaid-client.ts";
import { mermaid } from "./mermaid.ts";

// Blume ships TypeScript source. Use its installed loader for the real processor.
const requireBlume = createRequire(import.meta.resolve("blume/package.json"));
const { createJiti } = await import(requireBlume.resolve("jiti"));
const { blumeMarkdownProcessor } = await createJiti(import.meta.url).import("blume/markdown");

const renderer = async (bridge: boolean) => {
  const processor = blumeMarkdownProcessor();
  if (bridge) {
    const scripts = [];
    mermaid().hooks["astro:config:setup"]({
      config: { markdown: { processor } },
      injectScript: (...args) => scripts.push(args),
      updateConfig() {},
    });
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0][0], "page");
  }
  return processor.createRenderer({});
};

test("the bridge keeps ordinary Markdown and non-Mermaid fences unchanged", async () => {
  const markdown = '# Heading\n\nLiteral {braces}, <br>, & text.\n\n```sh\necho "<value>"\n```\n\n````md\n```mermaid\nA --> B\n```\n````';
  const native = await renderer(false);
  const bridged = await renderer(true);
  assert.deepEqual(await bridged.render(markdown), await native.render(markdown));
});

test("real Mermaid fences keep escaped source available through a summary without JavaScript", async () => {
  const source = 'flowchart LR\nA["<script>&</script> \'quoted\'"] --> B{result}';
  const markdown = `~~~mermaid\n${source}\n~~~\n\n> \`\`\`mermaid\n> not a valid diagram\n> \`\`\``;
  const { code } = await (await renderer(true)).render(markdown);
  assert.equal(code.match(/<docs-mermaid /g)?.length, 2);
  assert.equal(code.match(/<details><summary>Diagram source<\/summary><pre tabindex="0"><code>/g)?.length, 2);
  assert.ok(!code.includes("<button"));
  assert.equal(code.match(/class="mermaid-output"[^>]* hidden/g)?.length, 2);
  assert.ok(code.includes('A[&quot;&lt;script&gt;&amp;&lt;/script&gt; &#39;quoted&#39;&quot;] --&gt; B{result}'));
  assert.ok(code.includes("not a valid diagram</code>"));
  assert.ok(!code.includes("<script>"));
  assert.ok(!code.includes("blume-mermaid"));
});

// Only the DOM operations used by the element are needed for lifecycle checks.
class Part {
  hidden = true;
  open = false;
  innerHTML = "";
  attributes = new Map();
  parts = new Map();
  style = {};
  viewBox = { baseVal: { width: 960 } };
  setAttribute(name, value) { this.attributes.set(name, value); }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelector(selector) {
    if (selector.startsWith(":scope > ")) return this.parts.get(selector.slice(9));
    for (const [match, part] of this.parts) {
      if (match === selector) return part;
      const nested = part.querySelector?.(selector);
      if (nested) return nested;
    }
  }
  prepend(node) {
    this.parts.set(node.tagName.toLowerCase(), node);
    if (node.className) this.parts.set(`.${node.className}`, node);
  }
  click() { this.onclick?.(); }
}

const source = 'flowchart LR\nA["<input>"] --> B';
const flush = () => new Promise(setImmediate);
const setup = (load) => {
  const registry = new Map();
  const observers = [];
  const root = { dataset: { theme: "light" } };
  Object.assign(globalThis, {
    HTMLElement: class extends Part { isConnected = true; },
    customElements: { get: (name) => registry.get(name), define: (name, value) => registry.set(name, value) },
    document: {
      documentElement: root,
      createElement: (tagName) => Object.assign(new Part(), { tagName: tagName.toUpperCase(), hidden: false }),
    },
    getComputedStyle: () => ({ fontFamily: "Geist, sans-serif" }),
    MutationObserver: class {
      active = false;
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() { this.active = true; }
      disconnect() { this.active = false; }
    },
  });
  registerMermaid(load);
  const connect = (details = new Part()) => {
    const host = new (registry.get("docs-mermaid"))();
    const output = new Part();
    const image = new Part();
    output.parts.set("svg", image);
    details.parts.set("code", { textContent: source });
    host.parts = new Map([
      [".mermaid-output", output], ['[role="status"]', new Part()],
      ["details", details],
    ]);
    host.connectedCallback();
    return { host, output, image, size: host.querySelector(":scope > .mermaid-size"), details: host.parts.get("details"), status: host.parts.get('[role="status"]') };
  };
  const theme = (value) => {
    root.dataset.theme = value;
    for (const observer of observers.filter((item) => item.active)) observer.callback();
  };
  return { connect, theme, observers };
};

const result = { svg: '<svg viewBox="0 0 960 300"></svg>', diagramType: "flowchart" };

test("successful rendering is accessible, responsive up to its natural width, and loads the library once", async () => {
  const calls = [];
  const configs = [];
  let loads = 0;
  const page = setup(async () => {
    loads++;
    return {
      initialize: (config) => configs.push(config),
      render: async (id, text) => { calls.push({ id, text }); return result; },
    };
  });
  registerMermaid(async () => { throw new Error("Duplicate registration"); });
  const first = page.connect();
  const second = page.connect();
  second.image.setAttribute("aria-labelledby", "authored-title");
  await flush();
  assert.equal(loads, 1);
  assert.equal(new Set(calls.map(({ id }) => id)).size, 2);
  assert.ok(calls.every(({ text }) => text === source));
  assert.equal(first.details.open, false);
  assert.equal(first.output.hidden, false);
  assert.equal(first.image.attributes.get("role"), "img");
  assert.equal(first.image.attributes.get("aria-label"), "Diagram");
  assert.equal(second.image.attributes.get("aria-labelledby"), "authored-title");
  assert.equal(second.image.hasAttribute("aria-label"), false);
  assert.equal(first.image.style.width, "960px");
  assert.equal(first.image.style.maxWidth, "100%");
  assert.equal(first.output.hasAttribute("aria-busy"), false);
  assert.equal(configs[0].securityLevel, "strict");
  assert.equal(configs[0].suppressErrorRendering, true);
  assert.equal(configs[0].themeVariables.primaryTextColor, "#101828");
});

test("the client creates a size control from markup without a button and keeps its choice across themes and navigation", async () => {
  let renders = 0;
  let fail = false;
  const page = setup(async () => ({
    initialize() {},
    render: async () => { renders++; if (fail) throw new Error("Render failed"); return result; },
  }));
  const diagram = page.connect();
  assert.equal(diagram.size.tagName, "BUTTON");
  assert.equal(diagram.size.type, "button");
  assert.equal(diagram.size.hidden, true);
  await flush();
  assert.equal(diagram.size.hidden, false);
  assert.equal(diagram.size.textContent, "Show full-size diagram");
  assert.equal(diagram.image.style.maxWidth, "100%");
  diagram.size.click();
  assert.equal(diagram.image.style.width, "960px");
  assert.equal(diagram.image.style.maxWidth, "none");
  assert.equal(diagram.size.textContent, "Fit diagram to width");
  assert.equal(renders, 1);
  page.theme("dark");
  await flush();
  assert.equal(diagram.image.style.maxWidth, "none");
  diagram.host.isConnected = false;
  diagram.host.disconnectedCallback();
  diagram.host.isConnected = true;
  diagram.host.connectedCallback();
  await flush();
  assert.equal(diagram.host.querySelector(":scope > .mermaid-size"), diagram.size);
  assert.equal(diagram.image.style.maxWidth, "none");
  diagram.size.click();
  assert.equal(diagram.image.style.maxWidth, "100%");
  assert.equal(diagram.size.textContent, "Show full-size diagram");
  assert.equal(renders, 3);
  fail = true;
  page.theme("light");
  await flush();
  assert.equal(diagram.size.hidden, true);
  assert.equal(diagram.output.hidden, true);
  assert.equal(diagram.details.open, true);
});

test("the size control does not replace a nested source copy button", async () => {
  let copies = 0;
  const copy = new Part();
  copy.textContent = "Copy";
  copy.onclick = () => { copies++; };
  const pre = new Part();
  pre.parts.set("button", copy);
  const details = new Part();
  details.parts.set("pre", pre);
  const page = setup(async () => ({ initialize() {}, render: async () => result }));
  const diagram = page.connect(details);
  await flush();
  assert.notEqual(diagram.size, copy);
  assert.equal(copy.textContent, "Copy");
  diagram.size.click();
  assert.equal(diagram.image.style.maxWidth, "none");
  copy.click();
  assert.equal(copies, 1);
});

test("successful renders never change the reader's source choice", async () => {
  const pending = Promise.withResolvers();
  const page = setup(async () => ({ initialize() {}, render: () => pending.promise }));
  const opened = page.connect();
  const closed = page.connect();
  opened.details.open = true;
  await flush();
  pending.resolve(result);
  await flush();
  assert.equal(opened.output.hidden, false);
  assert.equal(opened.details.open, true);
  assert.equal(closed.details.open, false);
  opened.details.open = false;
  closed.details.open = true;
  page.theme("dark");
  await flush();
  assert.equal(opened.details.open, false);
  assert.equal(closed.details.open, true);
});

test("reconnect selects component children instead of matching elements in rendered labels", async () => {
  const sources = [];
  const page = setup(async () => ({
    initialize() {},
    render: async (_id, text) => {
      sources.push(text);
      if (sources.length === 2) throw new Error("Render failed");
      return result;
    },
  }));
  const diagram = page.connect();
  await flush();
  const labelDetails = new Part();
  const labelStatus = new Part();
  labelDetails.parts.set("code", { textContent: "rendered label" });
  diagram.image.parts.set("details", labelDetails);
  diagram.image.parts.set('[role="status"]', labelStatus);
  diagram.host.isConnected = false;
  diagram.host.disconnectedCallback();
  diagram.host.isConnected = true;
  diagram.host.connectedCallback();
  await flush();
  assert.deepEqual(sources, [source, source]);
  assert.equal(diagram.details.open, true);
  assert.equal(diagram.status.hidden, false);
  assert.equal(labelDetails.open, false);
  assert.equal(labelStatus.hidden, true);
});

test("library and parse failures leave the source open and do not stop other diagrams", async (t) => {
  for (const failure of ["load", "parse"]) {
    await t.test(failure, async () => {
      let count = 0;
      const page = setup(async () => {
        if (failure === "load") throw new Error("Load failed");
        return {
          initialize() {},
          render: async () => { if (++count === 1) throw new Error("Parse failed"); return result; },
        };
      });
      const failed = page.connect();
      const next = page.connect();
      await flush();
      assert.equal(failed.details.open, true);
      assert.equal(failed.status.hidden, false);
      assert.equal(failed.output.hidden, true);
      assert.equal(failed.size.hidden, true);
      assert.equal(failed.details.querySelector("code").textContent, source);
      assert.equal(failed.output.hasAttribute("aria-busy"), false);
      if (failure === "parse") assert.equal(next.output.hidden, false);
    });
  }
});

test("theme changes and navigation discard stale results without duplicate output", async () => {
  const pending = Promise.withResolvers();
  const configs = [];
  let calls = 0;
  const page = setup(async () => ({
    initialize: (config) => configs.push(config),
    render: async () => ++calls === 1 ? pending.promise : { ...result, svg: `<svg data-render="${calls}"></svg>` },
  }));
  const diagram = page.connect();
  await flush();
  page.theme("dark");
  page.theme("dark");
  // Initialization must not change while the first diagram is still rendering.
  assert.equal(configs.length, 1);
  pending.resolve({ ...result, svg: "stale" });
  await flush();
  assert.equal(calls, 2);
  assert.equal(configs[1].themeVariables.darkMode, true);
  assert.equal(configs[1].themeVariables.primaryTextColor, "#f0eee9");
  assert.equal(diagram.output.innerHTML, '<svg data-render="2"></svg>');
  diagram.details.open = true;
  page.theme("light");
  diagram.host.isConnected = false;
  diagram.host.disconnectedCallback();
  await flush();
  assert.equal(diagram.output.innerHTML, '<svg data-render="2"></svg>');
  assert.equal(page.observers.filter((observer) => observer.active).length, 0);
  diagram.host.isConnected = true;
  diagram.host.connectedCallback();
  await flush();
  assert.equal(diagram.details.open, true); // Keep the reader's source selection.
  assert.equal(diagram.output.innerHTML, '<svg data-render="4"></svg>');
  assert.equal(page.observers.filter((observer) => observer.active).length, 1);
});
