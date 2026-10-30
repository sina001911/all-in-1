/**
 * Theme (B1).
 *
 * Light / dark / system. `data-theme` is always the CONCRETE palette so every
 * token lookup resolves, never an unresolved "system". Dark is a neutral
 * blue-black ground rather than pure black, so panels read as recessed
 * surfaces instead of holes.
 */
"use strict";

function prefersDark() {
  if (typeof window.matchMedia === "function") {
    var q = window.matchMedia("(prefers-color-scheme: dark)");
    return !!q && q.matches === true;
  }
  return false;
}

function resolveTheme(theme) {
  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  return prefersDark() ? "dark" : "light";
}

/** Paint the resolved theme. */
function paintTheme() {
  var root = document.documentElement;
  if (root) root.dataset.theme = resolveTheme(state.theme);
  var resolved = resolveTheme(state.theme);
  ["light", "dark", "system"].forEach(function (name) {
    var btn = el("theme-" + name);
    if (btn) btn.setAttribute("aria-pressed", state.theme === name ? "true" : "false");
  });
  var selectNode = el("settings-theme");
  if (selectNode) selectNode.value = state.theme;
}

async function setTheme(theme) {
  state.theme = theme;
  paintTheme();
  try {
    state.settings = await api.patchSettings({ theme: theme });
    toast("Theme set to " + theme, "ok");
  } catch (e) {
    toast("Could not save the theme: " + esc(e), "danger");
  }
}