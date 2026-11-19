(function (): void {
  var d = document.documentElement;
  var dark = false;
  try {
    var t = localStorage.getItem("theme");
    dark = t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  } catch (e) {
    try { dark = matchMedia("(prefers-color-scheme: dark)").matches; } catch (e2) {}
  }
  d.dataset.theme = dark ? "dark" : "light";
  // Long code blocks are clamped and folded only when this flag is present:
  // set pre-paint, so a 500-line block never flashes open, and absent under
  // strict CSP hash checks if the inline script were ever dropped (in which
  // case every block correctly renders in full).
  try { d.dataset.js = "on"; } catch (e) {}
  // Set here, not in the lazily loaded search.js: CSS picks the modifier.
  try {
    var ua = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
    var plat = (ua && ua.platform) || navigator.platform || "";
    d.dataset.platform = /Mac|iPhone|iPad/i.test(plat) ? "mac" : "other";
  } catch (e) {
    d.dataset.platform = "other";
  }
  try {
    if (localStorage.getItem("sidebar") === "collapsed") d.dataset.sidebar = "collapsed";
    // Mirrors applyColumn() in toc.js.
    var toc = localStorage.getItem("toc");
    if (toc === "expanded" ? innerWidth >= 1080 : toc !== "collapsed" && innerWidth >= 1420) {
      d.dataset.column = "true";
    }
    // Clamp mirrors sidebar.js: keep 480px for the prose.
    var w = parseFloat(localStorage.getItem("sidebar-w") || "");
    var ceiling = Math.max(272, innerWidth - 480);
    if (w > 0) d.style.setProperty("--sidebar-w", Math.min(w, ceiling) + "px");
  } catch (e) {}
})();
