// Entry module: init document-level features once, then (re)hydrate the
// swapped DOM after each soft navigation via hydrate()/onNavigate().
import { flashTarget } from "./anchor.js";
import { initSoftNav, onNavigate } from "./spa.js";
import { initTabs } from "./tabs.js";
import { initTheme } from "./theme.js";
import { initDrawer } from "./drawer.js";
import { initTree } from "./tree.js";
import { initSidebarCollapse, initSidebarResize, initSidebarScroll } from "./sidebar.js";
import { setupScrollspy, initTocDrawer } from "./toc.js";
import { initCodeCopy, initAnchors, setupHeadingLinks, setupTables } from "./article.js";
import { initCrumbMenu } from "./crumb-menu.js";
import { initCodeFold, revealCodeFold } from "./code-block.js";
import { initDiagramView } from "./diagram.js";
import { initSearchEntry } from "./search-entry.js";
import { initReveal } from "./reveal.js";
import { armMedia, armComments } from "./media-comments.js";

initSoftNav();
initSearchEntry();
initTheme();
initDrawer();
initTocDrawer();
initTree();
initSidebarCollapse();
initSidebarResize();
initSidebarScroll();
initCodeCopy();
initCodeFold();
initDiagramView();
initCrumbMenu();
initAnchors();

// Re-applied after every full load and soft navigation.
function hydrate(): void {
  setupScrollspy();
  setupTables();
  setupHeadingLinks();
  initTabs();
  initReveal();
  armMedia();
  armComments();
}

// Deep links scroll natively; the CSS highlight is class-driven, so flash once.
function flashFromHash(): void {
  if (!location.hash || !document.getElementById("main")) return;
  let id: string;
  try {
    id = decodeURIComponent(location.hash.slice(1));
  } catch {
    id = location.hash.slice(1);
  }
  // A line anchor inside a folded block is clipped; expand before flashing so
  // the reader lands on a visible line instead of the block's head.
  const target = document.getElementById(id);
  if (target) {
    revealCodeFold(target);
    flashTarget(id);
  }
}

hydrate();
flashFromHash();
onNavigate(hydrate);