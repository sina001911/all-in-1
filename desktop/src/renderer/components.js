/**
 * Components (B1).
 *
 * Shared DOM helpers for the renderer. Loaded as a classic script BEFORE
 * renderer.js so its top-level functions are visible to the main module.
 *
 * DOM is built through `h()` and `text()`, which create nodes and TEXT NODES
 * only. `innerHTML` is never used with data, so model output, tool arguments,
 * filesystem paths, audit records and command strings cannot become markup.
 * `esc()` remains for the string paths that compose text directly.
 */
"use strict";

function esc(v) {
  return String(v).replace(/[&<>"]/g, function (c) {
    return "&#" + c.charCodeAt(0) + ";";
  });
}

function el(id) {
  return document.getElementById(id);
}

function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

function text(node, str) {
  clear(node);
  node.appendChild(document.createTextNode(String(str)));
}

/**
 * Element builder. `props` understands `class`, `text`, `on`, `dataset` and
 * any other attribute; children are appended as nodes. Never innerHTML.
 */
function h(tag, props, kids) {
  var node = document.createElement(tag);
  if (props) {
    for (var key in props) {
      var value = props[key];
      if (value === null || value === undefined) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.appendChild(document.createTextNode(String(value)));
      else if (key === "on") {
        for (var ev in value) node.addEventListener(ev, value[ev]);
      } else if (key === "dataset") {
        for (var dk in value) node.dataset[dk] = String(value[dk]);
      } else if (key === "innerHTML") {
        node.innerHTML = String(value);
      } else if (key === "attrs") {
        for (var ak in value) node.setAttribute(ak, String(value[ak]));
      } else node.setAttribute(key, String(value));
    }
  }
  if (kids) {
    for (var i = 0; i < kids.length; i++) {
      if (kids[i]) node.appendChild(kids[i]);
    }
  }
  return node;
}

function mono(value) {
  return h("pre", { class: "code", text: value });
}

/* ==================================================================
   Components
   ================================================================== */

function Button(label, opts) {
  opts = opts || {};
  // A button without an onClick is a no-op, not a throw: attaching
  // `undefined` as the handler makes the first click crash the renderer.
  var onClick = typeof opts.onClick === "function" ? opts.onClick : null;
  return h("button", {
    type: opts.type || "button",
    class: "btn" + (opts.variant ? " btn-" + opts.variant : "") + (opts.small ? " btn-sm" : ""),
    "aria-label": opts.ariaLabel || null,
    disabled: opts.disabled ? "disabled" : null,
    on: onClick ? { click: onClick } : null,
    text: label,
  });
}

function IconButton(label, title, onClick) {
  return Button(label, { onClick: onClick, ariaLabel: title, variant: "ghost" });
}

function TextInput(id, opts) {
  opts = opts || {};
  return h("input", {
    id: id,
    type: "text",
    class: "input",
    value: opts.value || "",
    placeholder: opts.placeholder || null,
    size: opts.size || null,
    on: opts.onInput ? { input: opts.onInput } : null,
  });
}

function Select(id, opts) {
  opts = opts || {};
  var node = h("select", {
    id: id,
    class: "select",
    on: opts.onChange ? { change: opts.onChange } : null,
  });
  (opts.options || []).forEach(function (o) {
    node.appendChild(h("option", { value: o.value, text: o.label }));
  });
  if (opts.value) node.value = opts.value;
  return node;
}

function Checkbox(id, label, opts) {
  opts = opts || {};
  var input = h("input", {
    id: id,
    type: "checkbox",
    on: opts.onChange ? { change: opts.onChange } : null,
  });
  return h("label", { class: "check", for: id }, [input, document.createTextNode(" " + label)]);
}

function Badge(label, tone) {
  return h("span", { class: "badge" + (tone ? " badge-" + tone : ""), text: label });
}

function Panel(title, kids) {
  var head = title ? h("h3", { text: title }) : null;
  var box = h("div", { class: "card card-pad" });
  if (head) box.appendChild(head);
  var body = h("div", { class: "stack", style: "margin-top:var(--s3)" });
  (kids || []).forEach(function (k) {
    if (k) body.appendChild(k);
  });
  box.appendChild(body);
  return box;
}

function Table(headers, rows) {
  var thead = h("thead", null, [
    h("tr", null, headers.map(function (label) {
      return h("th", { scope: "col", text: label });
    })),
  ]);
  var tbody = h("tbody", null, rows);
  return h("div", { style: "overflow:auto;border:1px solid var(--border);border-radius:var(--r-md)" }, [
    h("table", { class: "data" }, [thead, tbody]),
  ]);
}

function EmptyState(message) {
  return h("p", { class: "empty", text: message });
}

function SkeletonRow(count) {
  var box = h("div", { class: "stack" }, []);
  for (var i = 0; i < (count || 3); i++) {
    box.appendChild(h("div", { class: "skeleton" }));
  }
  return box;
}

/** A one-line error placeholder for a section that failed to load. */
function ErrorState(message) {
  return h("p", { class: "empty", text: "⚠ " + (message || "failed to load") });
}

function ErrorPanel(code, message, onRetry) {
  var kids = [
    h("div", { class: "row" }, [
      Badge("error", "danger"),
      h("code", { text: code || "ERROR" }),
    ]),
    h("p", { class: "muted", style: "margin:0", text: message || "" }),
  ];
  if (onRetry) kids.push(Button("Retry", { onClick: onRetry, small: true }));
  return h("div", { class: "error-panel stack" }, kids);
}

/* Toasts ------------------------------------------------------------- */
function toast(message, tone) {
  var host = el("toasts");
  if (!host) return;
  var node = h("div", { class: "toast" + (tone ? " toast-" + tone : ""), text: message });
  host.appendChild(node);
  setTimeout(function () {
    if (node.parentNode) node.parentNode.removeChild(node);
  }, 4200);
}

/* Modal -------------------------------------------------------------- */
var modalState = { resolve: null, lastFocus: null };

function openModal(title, bodyNode, opts) {
  opts = opts || {};
  var backdrop = el("modal-backdrop");
  text(el("modal-title"), title);
  clear(el("modal-body"));
  el("modal-body").appendChild(bodyNode);
  el("modal-confirm").textContent = opts.confirmLabel || "Confirm";
  el("modal-cancel").textContent = opts.cancelLabel || "Cancel";
  modalState.lastFocus = document.activeElement;
  backdrop.classList.add("open");
  var focusable = el("modal-body").querySelector("input, textarea, select, button");
  if (focusable && focusable.focus) focusable.focus();
  return new Promise(function (resolve) {
    modalState.resolve = resolve;
  });
}

function closeModal(value) {
  var backdrop = el("modal-backdrop");
  if (backdrop) backdrop.classList.remove("open");
  if (modalState.resolve) {
    var r = modalState.resolve;
    modalState.resolve = null;
    r(value);
  }
  if (modalState.lastFocus && modalState.lastFocus.focus) modalState.lastFocus.focus();
}

/* Tabs --------------------------------------------------------------- */
function selectTab(which) {
  var isTool = which === "tool";
  el("tab-tool").setAttribute("aria-selected", isTool ? "true" : "false");
  el("tab-log").setAttribute("aria-selected", isTool ? "false" : "true");
  el("pane-tool").hidden = !isTool;
  el("pane-log").hidden = isTool;
}

/* ==================================================================
   Model combobox (B2)
   ================================================================== */

/**
 * Build the visible combobox structure for a previously-created DOM container.
 * The hidden `<input id="model-select">` is updated whenever the user picks a
 * model; the input box shows displayName, the dropdown shows id + badges.
 *
 * Returns the container node so callers can mount it into the page.
 */
function ModelSelector(container) {
  var state = {
    catalog: [],          // [{id, provider, displayName, locality, costClass, status, capabilities, deterministic}]
    selected: "",         // model id (synced to #model-select)
    highlighted: -1,      // index into flat filtered list
    open: false,
    search: "",
    costFilter: "all",
  };

  var combobox = el("model-combobox");
  var input    = el("model-input");
  var list     = el("model-list");
  var hidden   = el("model-select");

  function close() {
    state.open = false;
    state.highlighted = -1;
    if (combobox) combobox.setAttribute("aria-expanded", "false");
    if (list) list.hidden = true;
    list.classList.remove("open");
  }

  function isOpen() {
    return state.open;
  }

  /** Sync the hidden input and exposed value property. */
  function syncHidden(value) {
    state.selected = value || "";
    if (hidden) hidden.value = value || "";
    // Update the visible input to show the selected model's display name.
    if (input) {
      if (value) {
        var m = state.catalog.find(function (x) { return x.id === value; });
        if (m) {
          input.value = m.displayName;
        } else {
          input.value = value; // fallback: show raw id
        }
      } else {
        input.value = "";
        input.placeholder = "Select a model…";
      }
    }
  }

  /** Set the full model catalogue and re-render. */
  function setCatalog(models) {
    state.catalog = (models || []).map(function (m) {
      return {
        id: m.id,
        provider: m.provider,
        displayName: m.displayName,
        locality: m.locality,
        costClass: m.costClass,
        status: m.status,
        capabilities: m.capabilities || [],
        deterministic: (m.locality === "local" && !m.streaming),
      };
    });
    state.highlighted = -1;
    render();
  }

  function setSearch(q) {
    state.search = (q || "").toLowerCase();
    state.highlighted = -1;
    render();
  }

  function setCostFilter(filter) {
    state.costFilter = filter || "all";
    state.highlighted = -1;
    render();
  }

  function getHighlightedId() {
    var filtered = getFiltered();
    if (state.highlighted >= 0 && state.highlighted < filtered.length) {
      return filtered[state.highlighted].id;
    }
    return null;
  }

  function getFiltered() {
    var q = state.search;
    var cf = state.costFilter;
    var result = [];
    for (var i = 0; i < state.catalog.length; i++) {
      var m = state.catalog[i];
      if (m.id === state.selected) continue; // already selected, skip
      var haystack = (m.displayName || m.id) + " " + m.id + " " + m.provider;
      var matchSearch = !q || haystack.toLowerCase().indexOf(q) !== -1;
      var matchCost = cf === "all" || m.costClass === cf;
      if (matchSearch && matchCost) result.push(m);
    }
    // Always keep current selection at top.
    if (state.selected) {
      var cur = state.catalog.find(function (x) { return x.id === state.selected; });
      if (cur) result.unshift(cur);
    }
    return result;
  }

  function highlightMatch(text, query) {
    if (!query || !text) return esc(text);
    var idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return esc(text);
    return esc(text.slice(0, idx)) +
      '<mark style="background:var(--accent-soft);color:var(--accent);border-radius:2px;padding:0 1px">' +
      esc(text.slice(idx, idx + query.length)) +
      '</mark>' + esc(text.slice(idx + query.length));
  }

  function render() {
    if (!list) return;
    clear(list);
    var filtered = getFiltered();

    if (filtered.length === 0) {
      var empty = h("li", { class: "model-empty" });
      if (state.catalog.length === 0) {
        text(empty, "Loading models…");
      } else if (state.search || state.costFilter !== "all") {
        text(empty, "No models match your filters.");
      } else {
        text(empty, "No models available.");
      }
      list.appendChild(empty);
      return;
    }

    // Group by locality.
    var localModels = [];
    var remoteModels = [];
    for (var i = 0; i < filtered.length; i++) {
      if (filtered[i].locality === "local") localModels.push(filtered[i]);
      else remoteModels.push(filtered[i]);
    }

    if (remoteModels.length > 0) {
      list.appendChild(h("li", { class: "model-group-label", text: "Remote Models" }));
      for (var j = 0; j < remoteModels.length; j++) {
        list.appendChild(buildOption(remoteModels[j]));
      }
    }
    if (localModels.length > 0) {
      list.appendChild(h("li", { class: "model-group-label", text: "Local / Test Models" }));
      for (var k = 0; k < localModels.length; k++) {
        list.appendChild(buildOption(localModels[k]));
      }
    }
  }

  function buildOption(m) {
    var badgeTone = m.deterministic ? "warn"
      : m.costClass === "FREE" ? "ok"
      : m.costClass === "PAID" ? "warn"
      : "info";
    var badgeLabel = m.deterministic ? "Deterministic"
      : m.costClass || "unknown";
    var caps = m.capabilities.length > 0
      ? h("span", { class: "badge", text: m.capabilities.join(", ") })
      : null;
    var row = h("li", {
      class: "model-option" + (state.highlighted >= 0 && getFiltered()[state.highlighted] === m ? " highlighted" : ""),
      role: "option",
      "aria-selected": m.id === state.selected ? "true" : "false",
      "data-id": m.id,
    }, [
      h("span", { class: "model-option-name", innerHTML: highlightMatch(m.displayName, state.search) }),
      h("span", { class: "model-option-id", text: m.id }),
      caps,
      Badge(badgeLabel, badgeTone),
    ]);
    row.addEventListener("click", function () {
      selectModel(m.id);
      close();
    });
    row.addEventListener("mouseenter", function () {
      var idx = getFiltered().indexOf(m);
      if (idx >= 0) setHighlight(idx);
    });
    return row;
  }

  function selectModel(id) {
    syncHidden(id);
  }

  function setHighlight(idx) {
    state.highlighted = idx;
    // Update aria-activedescendant.
    if (combobox) {
      var filtered = getFiltered();
      if (idx >= 0 && idx < filtered.length) {
        combobox.setAttribute("aria-activedescendant", "opt-" + filtered[idx].id);
      } else {
        combobox.removeAttribute("aria-activedescendant");
      }
    }
    // Re-render to update highlight classes.
    render();
    // Scroll highlighted into view.
    var opts = list.querySelectorAll(".model-option");
    for (var i = 0; i < opts.length; i++) {
      if (opts[i].classList.contains("highlighted")) {
        opts[i].scrollIntoView({ block: "nearest" });
        break;
      }
    }
  }

  function openDropdown() {
    state.open = true;
    if (combobox) combobox.setAttribute("aria-expanded", "true");
    if (list) {
      list.hidden = false;
      list.classList.add("open");
    }
    render();
    // Focus first option or keep current.
    var filtered = getFiltered();
    var curIdx = filtered.findIndex(function (m) { return m.id === state.selected; });
    setHighlight(curIdx >= 0 ? curIdx : 0);
  }

  function toggleDropdown() {
    if (state.open) close();
    else openDropdown();
  }

  // Keyboard navigation.
  function handleKeydown(e) {
    var filtered = getFiltered();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!state.open) { openDropdown(); return; }
      var next = Math.min(state.highlighted + 1, filtered.length - 1);
      setHighlight(next);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!state.open) { openDropdown(); return; }
      var prev = Math.max(state.highlighted - 1, 0);
      setHighlight(prev);
    } else if (e.key === "Enter" && state.open) {
      e.preventDefault();
      var id = getHighlightedId();
      if (id) { selectModel(id); close(); }
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
      if (input) input.blur();
    } else if (e.key === "Tab") {
      close();
    }
  }

  // Build event handlers once and reuse.
  function onInputFocus() {
    openDropdown();
    if (input) input.select();
  }

  function onInputClick() {
    toggleDropdown();
    if (input) input.select();
  }

  // Expose API.
  var api = {
    setCatalog: setCatalog,
    setSearch: setSearch,
    setCostFilter: setCostFilter,
    select: selectModel,
    getSelected: function () { return state.selected; },
    getHighlightedId: getHighlightedId,
    isOpen: isOpen,
    open: openDropdown,
    close: close,
    toggle: toggleDropdown,
    handleKeydown: handleKeydown,
    onInputFocus: onInputFocus,
    onInputClick: onInputClick,
  };
  return api;
}