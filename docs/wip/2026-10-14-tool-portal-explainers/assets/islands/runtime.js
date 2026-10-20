import { t as e } from "./chunks/source-text-DYZnavjV.js";
//#region src/html-islands/markdown-diagram-islands.ts
var t = class extends HTMLElement {
	connectedCallback() {
		this.renderContent();
	}
	async renderContent() {
		if (this.hasAttribute("prepared")) return;
		let e = this.querySelector("script[type=\"text/markdown\"]")?.textContent ?? "";
		try {
			let { renderMarkdownContent: t } = await import("./chunks/markdown-content-Do4hNQPi.js");
			this.innerHTML = t(e), this.setAttribute("prepared", ""), this.dispatchEvent(new Event("island-ready", { bubbles: !0 }));
		} catch (e) {
			this.textContent = `Markdown could not render: ${String(e)}`;
		}
	}
}, n = class extends HTMLElement {
	connectedCallback() {
		if (this.hasAttribute("prepared")) return;
		let e = new IntersectionObserver((t) => {
			t.some((e) => e.isIntersecting) && (e.disconnect(), this.renderDiagram());
		});
		e.observe(this);
	}
	async renderDiagram() {
		if (this.hasAttribute("prepared")) return;
		let t = this.querySelector("script[type=\"text/plain\"]")?.textContent ?? this.querySelector("template")?.content.textContent ?? "";
		try {
			let { renderMermaidSVG: n } = await import("./chunks/dist-CqZm1SKH.js");
			this.innerHTML = n(e(t), {
				bg: "var(--sheet)",
				fg: "var(--ink)",
				accent: "var(--accent)",
				surface: "var(--accent-soft)",
				border: "var(--rule)",
				font: "IBM Plex Sans Condensed",
				transparent: !0
			}), this.setAttribute("prepared", ""), this.dispatchEvent(new Event("island-ready", { bubbles: !0 }));
		} catch (e) {
			this.textContent = `Mermaid could not render: ${String(e)}`;
		}
	}
}, r = class extends HTMLElement {
	connectedCallback() {
		this.hasAttribute("prepared") || (this.textContent = "Package this D2 reference to inline SVG before opening the document.");
	}
}, i = class extends HTMLElement {
	connectedCallback() {
		let e = Array.from(this.children).filter((e) => e instanceof HTMLElement), t = document.createElement("div");
		t.className = "ex-tab-bar", t.setAttribute("role", "tablist");
		let n = e.map((t, i) => {
			let a = document.createElement("button");
			return a.type = "button", a.textContent = t.getAttribute("label") ?? `View ${i + 1}`, a.setAttribute("role", "tab"), t.id ||= `ex-panel-${crypto.randomUUID()}`, a.id = `${t.id}-tab`, a.setAttribute("aria-controls", t.id), t.setAttribute("role", "tabpanel"), t.setAttribute("aria-labelledby", a.id), a.addEventListener("click", () => r(i)), a.addEventListener("keydown", (t) => {
				let a = t.key === "ArrowRight" ? (i + 1) % e.length : t.key === "ArrowLeft" ? (i + e.length - 1) % e.length : t.key === "Home" ? 0 : t.key === "End" ? e.length - 1 : void 0;
				a !== void 0 && (t.preventDefault(), r(a), n[a]?.focus());
			}), a;
		});
		function r(t) {
			e.forEach((e, n) => {
				e.hidden = n !== t;
			}), n.forEach((e, n) => {
				e.setAttribute("aria-selected", String(n === t)), e.tabIndex = n === t ? 0 : -1;
			});
		}
		t.append(...n), this.prepend(t), r(0);
	}
}, a = class extends HTMLElement {
	closeExpandedView;
	disconnectedCallback() {
		this.closeExpandedView && document.removeEventListener("keydown", this.closeExpandedView);
	}
	connectedCallback() {
		let e = document.createElement("div");
		e.className = "ex-viewport";
		let t = document.createElement("div");
		t.className = "ex-zoom-content", t.append(...this.childNodes), e.append(t);
		let n = document.createElement("div");
		n.className = "ex-zoom-toolbar";
		let r = 1, i = 0, a = 0, o = () => {
			t.style.transform = `translate(${i}px, ${a}px) scale(${r})`;
		}, s = (e, t) => {
			let r = document.createElement("button");
			r.type = "button", r.textContent = e, r.addEventListener("click", t), n.append(r);
		};
		s("Zoom in", () => {
			r = Math.min(3, r + .25), o();
		}), s("Zoom out", () => {
			r = Math.max(.5, r - .25), o();
		}), s("Reset view", () => {
			r = 1, i = 0, a = 0, o();
		});
		let c = document.createElement("button");
		c.type = "button", c.textContent = "Expand diagram", c.setAttribute("aria-expanded", "false");
		let l = (e) => {
			this.toggleAttribute("expanded", e), c.textContent = e ? "Return to document" : "Expand diagram", c.setAttribute("aria-expanded", String(e));
		};
		c.addEventListener("click", () => {
			l(!this.hasAttribute("expanded"));
		}), n.append(c), this.closeExpandedView = (e) => {
			e.key === "Escape" && this.hasAttribute("expanded") && (l(!1), c.focus());
		}, document.addEventListener("keydown", this.closeExpandedView);
		let u;
		e.addEventListener("pointerdown", (t) => {
			t.target instanceof Element && t.target.closest("a,button") || (u = {
				x: t.clientX,
				y: t.clientY,
				offsetX: i,
				offsetY: a
			}, e.setPointerCapture(t.pointerId));
		}), e.addEventListener("pointermove", (e) => {
			u && (i = u.offsetX + e.clientX - u.x, a = u.offsetY + e.clientY - u.y, o());
		}), e.addEventListener("pointerup", () => {
			u = void 0;
		}), e.addEventListener("pointercancel", () => {
			u = void 0;
		}), this.append(n, e);
	}
}, o = class extends HTMLElement {}, s = class extends HTMLElement {
	connectedCallback() {
		this.classList.add("decision");
	}
}, c = class extends HTMLElement {
	connectedCallback() {
		this.classList.add("why");
	}
}, l = class extends HTMLElement {
	connectedCallback() {
		this.classList.add("ex-compare");
	}
}, u = class extends HTMLElement {
	connectedCallback() {
		this.classList.add("ex-timeline");
	}
}, d = class extends HTMLElement {
	connectedCallback() {
		this.classList.add("band");
	}
}, f = class extends HTMLElement {
	connectedCallback() {
		this.classList.add("ex-file-tree"), this.textContent = e(this.querySelector("script[type=\"text/plain\"]")?.textContent ?? this.textContent ?? "");
	}
}, p = class extends l {};
for (let [e, m] of [
	["ex-markdown", t],
	["ex-mermaid", n],
	["ex-d2", r],
	["ex-tabs", i],
	["ex-zoom", a],
	["ex-decision", s],
	["ex-callout", c],
	["ex-compare", l],
	["ex-diagram-diff", p],
	["ex-timeline", u],
	["ex-layer", d],
	["ex-file-tree", f],
	["ex-document", o]
]) customElements.get(e) || customElements.define(e, m);
document.addEventListener("click", (e) => {
	if (!(e.target instanceof Element)) return;
	if (e.target.closest("[data-ex-theme]")) {
		document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
		return;
	}
	let t = e.target.closest("a")?.getAttribute("href");
	if (!t?.startsWith("#")) return;
	let n = document.getElementById(t.slice(1));
	if (n) for (let e = n.parentElement; e; e = e.parentElement) e.getAttribute("role") === "tabpanel" && e.parentElement?.querySelector(`button[aria-controls="${CSS.escape(e.id)}"]`)?.click(), e instanceof HTMLDetailsElement && (e.open = !0);
});
//#endregion
