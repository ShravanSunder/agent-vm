//#region src/html-islands/source-text.ts
function e(e) {
	let t = e.replaceAll("\r\n", "\n").split("\n"), n = t.filter((e) => e.trim().length > 0), r = Math.min(...n.map((e) => /^[\t ]*/.exec(e)?.[0].length ?? 0));
	return Number.isFinite(r) ? t.map((e) => e.slice(Math.min(r, /^[\t ]*/.exec(e)?.[0].length ?? 0))).join("\n").trim() : "";
}
//#endregion
export { e as t };
