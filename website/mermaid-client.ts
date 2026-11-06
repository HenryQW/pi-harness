import type { Mermaid } from "mermaid";

type LoadMermaid = () => Promise<Pick<Mermaid, "initialize" | "render">>;

export function registerMermaid(load: LoadMermaid = async () => (await import("mermaid")).default) {
  if (customElements.get("docs-mermaid")) return;

  let library: ReturnType<LoadMermaid>;
  let queue = Promise.resolve();
  let counter = 0;

  // Mermaid has shared configuration. Keep initialization and rendering together,
  // including when several diagrams render during a theme change.
  const render = (source: string, dark: boolean, fontFamily: string) => {
    const task = queue.then(async () => {
      const mermaid = await (library ??= load());
      const ink = dark ? "#f0eee9" : "#101828";
      const surface = dark ? "#18243a" : "#ffffff";
      mermaid.initialize({
        layout: "dagre",
        look: "classic",
        securityLevel: "strict",
        startOnLoad: false,
        suppressErrorRendering: true,
        theme: "base",
        themeVariables: {
          darkMode: dark,
          fontFamily,
          background: dark ? "#101828" : "#f0eee9",
          primaryColor: surface,
          primaryTextColor: ink,
          primaryBorderColor: ink,
          secondaryColor: surface,
          secondaryTextColor: ink,
          secondaryBorderColor: ink,
          tertiaryColor: dark ? "#18243a" : "#e6e4de",
          tertiaryTextColor: ink,
          tertiaryBorderColor: ink,
          lineColor: dark ? "#cdd1d9" : "#4c5665",
        },
      });
      return mermaid.render(`docs-mermaid-${++counter}`, source);
    });
    queue = task.then(() => {}, () => {});
    return task;
  };

  customElements.define("docs-mermaid", class extends HTMLElement {
    #observer: MutationObserver | null = null;
    #token = 0;
    #naturalWidth = false;

    connectedCallback() {
      const output = this.querySelector<HTMLElement>(":scope > .mermaid-output")!;
      let size = this.querySelector<HTMLButtonElement>(":scope > .mermaid-size");
      if (!size) {
        size = document.createElement("button");
        size.type = "button";
        size.className = "mermaid-size";
        size.hidden = true;
        this.prepend(size);
      }
      const resize = () => {
        output.querySelector("svg")!.style.maxWidth = this.#naturalWidth ? "none" : "100%";
        size.textContent = this.#naturalWidth ? "Fit diagram to width" : "Show full-size diagram";
      };
      size.onclick = () => {
        this.#naturalWidth = !this.#naturalWidth;
        resize();
      };
      const status = this.querySelector<HTMLElement>(':scope > [role="status"]')!;
      const details = this.querySelector<HTMLDetailsElement>(":scope > details")!;
      const source = details.querySelector("code")!.textContent;
      const isDark = () => document.documentElement.dataset.theme === "dark";
      let dark = isDark();

      const update = async () => {
        const token = ++this.#token;
        output.setAttribute("aria-busy", "true");
        try {
          const { svg } = await render(source, dark, getComputedStyle(this).fontFamily);
          if (token !== this.#token || !this.isConnected) return;
          // Mermaid's strict security mode sanitizes this generated markup.
          output.innerHTML = svg;
          const image = output.querySelector("svg")!;
          image.setAttribute("role", "img");
          if (!image.hasAttribute("aria-labelledby") && !image.hasAttribute("aria-label")) {
            image.setAttribute("aria-label", "Diagram");
          }
          // Fit by default; full size uses the region's horizontal scroll bar.
          const width = image.viewBox.baseVal.width;
          if (width > 0) image.style.width = `${width}px`;
          resize();
          size.hidden = false;
          output.hidden = false;
          status.hidden = true;
        } catch {
          if (token !== this.#token || !this.isConnected) return;
          output.hidden = true;
          size.hidden = true;
          status.hidden = false;
          details.open = true;
        } finally {
          if (token === this.#token) output.removeAttribute("aria-busy");
        }
      };

      void update();
      this.#observer = new MutationObserver(() => {
        if (isDark() === dark) return;
        dark = isDark();
        void update();
      });
      this.#observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    }

    disconnectedCallback() {
      ++this.#token;
      this.#observer?.disconnect();
      this.#observer = null;
    }
  });
}
