(function (): void {
  try {
    var stored: Record<string, boolean> = JSON.parse(localStorage.getItem("tree-open") || "{}") || {};
    var list = document.querySelectorAll<HTMLDetailsElement>(".sidebar details[data-href]");
    var i: number, d: HTMLDetailsElement, k: string | null;

    for (i = 0; i < list.length; i++) {
      d = list[i];
      k = d.getAttribute("data-href");
      d.open = !!d.querySelector('[aria-current="page"]') || (!!k && stored[k] === true);
    }
    for (i = 0; i < list.length; i++) {
      k = list[i].getAttribute("data-href");
      if (k) stored[k] = list[i].open;
    }
    localStorage.setItem("tree-open", JSON.stringify(stored));
  } catch (e) {}

  try {
    var nav = document.querySelector<HTMLElement>(".sidebar .sidebar-nav");
    var top = Number(sessionStorage.getItem("sidebar-scroll"));
    if (nav && top > 0) nav.scrollTop = top;
  } catch (e) {}
})();
