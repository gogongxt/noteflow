// Entry module: init document-level features once, then (re)hydrate the
// swapped DOM after each soft navigation via hydrate()/onNavigate().
import { flashTarget } from "./anchor.js";
import { initSoftNav, onNavigate } from "./spa.js";
import { initTabs } from "./tabs.js";
import { initTheme } from "./theme.js";
import { initDrawer } from "./drawer.js";
import { initTree } from "./tree.js";
import { initSidebarCollapse, initSidebarResize, initSidebarScroll } from "./sidebar.js";
import { setupScrollspy } from "./toc.js";
import { initCodeCopy, initCrumbFlyouts, initAnchors, setupHeadingLinks, setupTables } from "./article.js";
import { initSearchEntry } from "./search-entry.js";
import { armMedia, armComments } from "./media-comments.js";

initSoftNav();
initSearchEntry();
initTheme();
initDrawer();
initTree();
initSidebarCollapse();
initSidebarResize();
initSidebarScroll();
initCodeCopy();
initCrumbFlyouts();
initAnchors();

// Re-applied after every full load and soft navigation.
function hydrate(): void {
  setupScrollspy();
  setupTables();
  setupHeadingLinks();
  initTabs();
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
  flashTarget(id);
}

hydrate();
flashFromHash();
onNavigate(hydrate);