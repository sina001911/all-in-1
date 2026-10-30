/**
 * i18n (B1).
 *
 * English (LTR) / Farsi (RTL). The document flips `data-dir` and swaps the
 * font stack; every labelled element carries `data-en` / `data-fa` and
 * re-renders its text. Nothing here touches the backend.
 */
"use strict";

/** Re-apply the current language to a single labelled element. */
function applyLabel(node, lang) {
  if (!node || node.nodeType !== 1) return;
  var fa = node.getAttribute("data-fa");
  var en = node.getAttribute("data-en");
  if (!fa && !en) return;
  node.textContent = (lang === "fa" && fa) ? fa : (en || "");
}

function setLanguage(lang) {
  state.lang = lang;
  var root = document.documentElement;
  if (root) {
    root.lang = lang;
    root.dataset.dir = lang === "fa" ? "rtl" : "ltr";
  }
  var langSelect = el("lang-select");
  if (langSelect) langSelect.value = lang;
  // Toggle data-en/data-fa text on every labelled element.
  var labelled = document.querySelectorAll("[data-en]");
  for (var i = 0; i < labelled.length; i++) {
    applyLabel(labelled[i], lang);
  }
  // Dynamic content (toasts, model options, transcript entries, badges) is
  // created after the language is chosen, so a one-time sweep misses it. A
  // child-list observer catches labelled nodes the moment they are mounted,
  // whether the switch happened before or after they were created.
  if (!i18nObserver) {
    i18nObserver = new MutationObserver(function (mutations) {
      for (var mi = 0; mi < mutations.length; mi++) {
        var added = mutations[mi].addedNodes;
        for (var nj = 0; nj < added.length; nj++) {
          var node = added[nj];
          if (node.nodeType !== 1) continue;
          applyLabel(node, state.lang);
          var descendants = node.querySelectorAll
            ? node.querySelectorAll("[data-en]")
            : [];
          for (var nd = 0; nd < descendants.length; nd++) {
            applyLabel(descendants[nd], state.lang);
          }
        }
      }
    });
    if (document.body) i18nObserver.observe(document.body, { childList: true, subtree: true });
  }
  // Let the renderer re-render any view that builds text at mount time.
  window.dispatchEvent(new CustomEvent("all-in-1:languagechange", { detail: { lang: lang } }));
  toast("Language: " + (lang === "fa" ? "فارسی" : "English"), "ok");
}

var i18nObserver = null;