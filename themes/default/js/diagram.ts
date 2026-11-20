// The diagram view switch. The build ships the SVG and the Mermaid source in
// the same figure; this flips the figure's data-view. Markup and styles are
// static, so without scripting the diagram alone shows.

export function initDiagramView(): void {
  document.addEventListener("click", (e) => {
    const tab = (e.target as Element | null)?.closest?.(".diagram-tab");
    if (!(tab instanceof HTMLButtonElement)) return;
    const fig = tab.closest<HTMLElement>(".diagram");
    if (!fig) return;
    const view = tab.dataset.view === "source" ? "source" : "diagram";
    if (fig.dataset.view === view) return;
    fig.dataset.view = view;
    for (const t of fig.querySelectorAll<HTMLButtonElement>(".diagram-tab")) {
      t.setAttribute("aria-pressed", String(t.dataset.view === view));
    }
  });
}
