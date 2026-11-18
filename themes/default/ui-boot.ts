// Pre-paint: open saved groups and the current page's chain, then sync the
// expand/collapse-all control.
(function (): void {
  var sidebar = document.getElementById("sidebar");
  if (!sidebar) return;
  var read = function (json: string | null): Record<string, boolean> {
    try {
      var v = JSON.parse(json || "{}");
      return v && typeof v === "object" ? v : {};
    } catch (e) {
      return {};
    }
  };
  var groups: string[] = [];
  try {
    groups = JSON.parse(sidebar.dataset.treeGroups || "[]") || [];
  } catch (e) {}
  var open = read(localStorage.getItem("tree-open"));
  var all = sidebar.querySelectorAll<HTMLDetailsElement>("details[data-key]");
  var i: number, k: string | null;
  for (i = 0; i < all.length; i++) {
    k = all[i].dataset.key || null;
    if (k && all[i].querySelector('[aria-current="page"]')) open[k] = true;
  }
  for (i = 0; i < all.length; i++) all[i].open = !!open[all[i].dataset.key || ""];
  // Prune keys for groups that no longer exist.
  var kept: Record<string, boolean> = {};
  for (i = 0; i < groups.length; i++) {
    k = groups[i];
    if (open[k]) kept[k] = true;
    else if (k in open) kept[k] = false;
  }
  try {
    localStorage.setItem("tree-open", JSON.stringify(kept));
  } catch (e) {}

  var btn = document.querySelector<HTMLElement>("[data-tree-all]");
  if (btn) {
    var every = groups.length > 0;
    for (i = 0; i < groups.length; i++) if (!open[groups[i]]) every = false;
    btn.setAttribute("aria-expanded", String(every));
    btn.setAttribute("aria-label", every ? "Collapse all" : "Expand all");
    btn.title = btn.getAttribute("aria-label") || "";
    btn.classList.toggle("is-open", every);
  }

  var nav = sidebar.querySelector<HTMLElement>(".sidebar-nav");
  var top = Number(sessionStorage.getItem("sidebar-scroll"));
  if (nav && top > 0) nav.scrollTop = top;
})();