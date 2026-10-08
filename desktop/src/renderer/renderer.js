/**
 * Renderer (D6).
 *
 * Runs in a sandboxed page with NO Node access. Its only capability is the
 * `window.allInOne` object the preload exposes — an enumerated API. There is no
 * filesystem, no process, no engine access, and no way to read a credential
 * value back.
 *
 * PLAIN JAVAVASCRIPT, not TypeScript: Chromium parses page scripts as-is and
 * transpiles nothing, so a `.js` file carrying type annotations is a syntax
 * error and the whole page dies. (D1 shipped it that way; D5 fixed it; D6
 * keeps it fixed.) There is no build step and no dependency.
 *
 * DOM is built through `h()` and `text()`, which create nodes and TEXT NODES
 * only. `innerHTML` is never used with data, so model output, tool arguments,
 * filesystem paths, audit records and command strings cannot become markup.
 * `esc()` remains for the string paths that compose text directly.
 *
 * Trust model, unchanged by any amount of polish: the model is untrusted, this
 * UI is untrusted, and a tool call is a QUESTION. A request is settled only by
 * the human's Approve/Deny here, never by the model's own justification — which
 * is labelled and shown as evidence precisely because it is not consent.
 */
(function () {
  "use strict";

  var api = window.allInOne;

  /* ==================================================================
     Core helpers
     ================================================================== */

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
    return h("button", {
      type: opts.type || "button",
      class: "btn" + (opts.variant ? " btn-" + opts.variant : "") + (opts.small ? " btn-sm" : ""),
      "aria-label": opts.ariaLabel || null,
      disabled: opts.disabled ? "disabled" : null,
      on: { click: opts.onClick },
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

  function TextArea(id, opts) {
    opts = opts || {};
    return h("textarea", {
      id: id,
      class: "textarea",
      rows: opts.rows || 3,
      placeholder: opts.placeholder || null,
      value: opts.value || "",
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

  function RunStatePill(result) {
    if (!result) return h("span", { class: "badge", text: "no run yet" });
    if (result.escalated) return Badge("escalated", "warn");
    if (result.pausedForHuman) return Badge("paused for you", "info");
    if (result.ok) return Badge("ok", "ok");
    return Badge((result.error && result.error.code) || "failed", "danger");
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
     State
     ================================================================== */

  var state = {
    theme: "system",
    settings: null,
    view: "agent",
    mode: "INSPECT",
    runId: "",
    busy: false,
    lastResult: null,
    selectedRunId: null,
    runs: [],
    pending: [],
    firstRunDismissed: false,
  };

  var MODES = ["INSPECT", "SUGGEST", "BUILD"];

  var MODE_HELP = {
    INSPECT: "Read-only analysis. The model is never even shown a write, execute or network tool.",
    SUGGEST: "Analysis and planning. No privileged tool is offered.",
    BUILD: "Privileged tools are offered — files.write, files.edit, process.exec. Every one waits for your approval here.",
  };

  /* ==================================================================
     Theme (M1)
     ================================================================== */

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

  /** Paint the resolved theme. `data-theme` is always the CONCRETE palette so
   *  every token lookup resolves, never an unresolved "system". */
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

  /* ==================================================================
     Navigation (M2)
     ================================================================== */

  function showView(name) {
    state.view = name;
    var items = document.querySelectorAll(".nav-item");
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.getAttribute("data-view") === name) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }
    MODES.concat(["agent", "runs", "tools", "approvals", "audit", "models", "workspace", "settings"]).forEach(function (v) {
      var view = el("view-" + v);
      if (view) view.classList.toggle("active", v === name);
    });
    refreshView(name).catch(function () {});
  }

  /* ==================================================================
     Agent view (M3)
     ================================================================== */

  function turnRow(kind, title, bodyKids, extras) {
    var head = h("div", { class: "turn-head" }, [Badge(title)]);
    if (extras) head.appendChild(extras);
    return h("div", { class: "turn turn-" + kind }, [
      head,
      h("div", { class: "turn-body" }, bodyKids),
    ]);
  }

  function renderTurn(ev) {
    if (ev.kind === "user") {
      return turnRow("user", "you", [document.createTextNode(ev.text || "")]);
    }
    if (ev.kind === "assistant") {
      var kids = [document.createTextNode(ev.text || "(no text)")];
      var calls = ev.toolCalls || [];
      if (calls.length > 0) {
        var list = h("div", { class: "stack", style: "margin-top:var(--s2)" }, []);
        calls.forEach(function (c) {
          list.appendChild(
            h("div", { class: "muted mono", text: "→ " + c.toolName + " " + JSON.stringify(c.input) }),
          );
        });
        kids.push(list);
      }
      return turnRow("assistant", "model", kids);
    }
    var oc = (ev && ev.outcome) || {};
    var tone = oc.ok ? "ok" : "danger";
    var label = oc.ok ? "ok" : (oc.code || "failed");
    var headExtra = oc.approved ? Badge("approved by you", "warn") : null;
    var bodyKids = [document.createTextNode(String(oc.toolName || "tool") + " — " + label)];
    if (oc.excerpt) {
      var details = h("details", null, [
        h("summary", { text: "result" }),
        h("div", { class: "excerpt", text: String(oc.excerpt) }),
      ]);
      bodyKids.push(details);
    }
    return turnRow("tool", label, bodyKids, headExtra);
  }

  function renderTranscript(result) {
    var host = el("transcript");
    clear(host);
    var history = (result && result.history) || [];
    if (history.length === 0) {
      host.appendChild(
        EmptyState("No turns yet — send a prompt above and the model's reasoning and tool activity appear here."),
      );
      return;
    }
    history.forEach(function (ev) {
      host.appendChild(renderTurn(ev));
    });
    host.scrollTop = host.scrollHeight;
  }

  function setAgentState(node, result) {
    var parts = [];
    if (result) {
      parts.push("turns " + result.turns);
      parts.push("approved edits " + result.approvedEdits);
    }
    parts.push(state.busy ? "running…" : (result ? "idle" : "no run yet"));
    text(node, parts.join(" · "));
  }

  function syncAgentState() {
    var host = el("agent-state");
    clear(host);
    host.appendChild(RunStatePill(state.lastResult));
    var hint = el("agent-hint");
    if (hint && state.lastResult && state.lastResult.pausedForHuman) {
      text(hint, "Run again on the same run id to continue.");
    }
  }

  async function runAgent() {
    if (state.busy) return;
    var prompt = el("agent-prompt").value;
    if (!prompt || !prompt.trim()) {
      toast("Type a prompt first.", "warn");
      el("agent-prompt").focus();
      return;
    }
    // D12: the progressive stream must be torn down even on cancel/throw, so
    // its state is fully reset BEFORE the try.
    state.busy = true;
    state.liveStream = null;
    el("agent-run").disabled = true;
    el("agent-cancel").disabled = false;
    text(el("transcript"), "");
    var transcript = el("transcript");
    clear(transcript);
    transcript.appendChild(SkeletonRow(3));
    var streaming = el("agent-stream") ? el("agent-stream").checked !== false : false;
    var streamCursor = 0;
    var streamTimer = null;
    var streamRow = null;

    function stopStreamPoll() {
      if (streamTimer !== null) {
        clearInterval(streamTimer);
        streamTimer = null;
      }
    }

    function pushStreamRow(ev) {
      // One incremental row per run: progressive text arrives as text chunks;
      // tool-call frames summarize as they are produced. The final AgentResult
      // replaces the entire row so there is no duplicate tail.
      if (!streamRow) {
        streamRow = h("div", { class: "turn turn-assistant", id: "agent-live-row" }, [
          h("div", { class: "turn-head" }, [Badge("model")]),
          h("div", { class: "turn-body", id: "agent-live-body" }, [SkeletonRow(1)]),
        ]);
        clear(transcript);
        transcript.appendChild(streamRow);
      }
      var body = document.getElementById("agent-live-body");
      if (ev.kind === "text") {
        if (!state.liveStream) state.liveStream = "";
        state.liveStream += ev.text;
        text(body, state.liveStream);
      } else if (ev.kind === "tool-call-delta") {
        if (!state.liveStream) state.liveStream = "";
        state.liveStream += "\n[workflow tool fragment] ";
        text(body, state.liveStream);
      } else if (ev.kind === "usage") {
        if (!state.liveStream) state.liveStream = "";
        state.liveStream += `\n[usage: ${ev.promptTokens ?? 0}+${ev.completionTokens ?? 0}]`;
        text(body, state.liveStream);
      } else if (ev.kind === "finish") {
        if (!state.liveStream) state.liveStream = "";
        state.liveStream += `\n[finish${ev.finishReason ? ": " + ev.finishReason : ""}]`;
        text(body, state.liveStream);
      }
      transcript.scrollTop = transcript.scrollHeight;
    }

    async function pollStream() {
      try {
        var env = await api.getAgentStream(state.runId || "pending-" + Date.now().toString(36), streamCursor);
        if (!env) return;
        for (var i = 0; i < env.events.length; i++) pushStreamRow(env.events[i]);
        streamCursor = env.nextIndex;
        if (env.state !== "running") stopStreamPoll();
      } catch (_e) {
        /* the run promise is the authoritative final word; polling must never mask it */
      }
    }

    // D12: opt-in progressive events in the UI only. The run is still
    // single-buffered in the core contract — the progressive frames feed the
    // live preview row, never the persistence layer.
    if (streaming) {
      var earlyRunId = state.runId || "pending-" + Date.now().toString(36);
      state.runId = earlyRunId;
      streamTimer = setInterval(pollStream, 300);
    }
    try {
      var result = await api.runAgent({
        runId: state.runId || "ui-" + Date.now().toString(36),
        prompt: prompt,
        mode: state.mode,
        auto: el("agent-auto").checked ? { auto: true } : undefined,
        streaming: streaming,
      });
      state.runId = result.runId || "";
      el("agent-run-id").value = state.runId;
      el("agent-prompt").value = "";
      state.lastResult = result;
      // One final render REPLACES, never appends: the pending stream row and
      // its skeleton are replaced by the assembled history.
      renderTranscript(result);
      if (result.escalated) toast("Escalated: the run paused for intervention.", "warn");
      else if (result.pausedForHuman) toast("Paused for you. Send again on the same run id to continue.", "info");
      else if (result.ok) toast("Run complete.", "ok");
      else toast("Run failed: " + esc((result.error && result.error.code) || "unknown"), "danger");
      await loadApprovals();
    } catch (e) {
      clear(el("transcript"));
      el("transcript").appendChild(ErrorPanel("RENDERER", esc(e), null));
    } finally {
      stopStreamPoll();
      state.liveStream = null;
      state.busy = false;
      el("agent-run").disabled = false;
      el("agent-cancel").disabled = true;
      syncAgentState();
      await refreshStatus();
    }
  }

  async function cancelAgent() {
    if (!state.runId) return;
    await api.cancelRun(state.runId);
    toast("Cancelled. Any pending approval was released — never approved.", "warn");
    await loadApprovals();
  }

  /* ==================================================================
     Approvals (M3)
     ================================================================== */

  function approvalCard(p, resolved) {
    var kids = [
      h("div", { class: "row" }, [
        Badge(p.toolName),
        Badge(p.permission, "info"),
        resolved ? Badge(p.status, p.status === "approved" ? "ok" : "danger") : Badge("awaiting you", "warn"),
      ]),
      h("div", { class: "mono faint", style: "margin-top:var(--s1)", text: "input: " + JSON.stringify(p.inputSummary) }),
    ];
    if (p.justification) {
      kids.push(h("div", { class: "muted", style: "margin-top:var(--s2)" }, [
        h("strong", { text: "Model's justification (evidence, not consent): " }),
        document.createTextNode(String(p.justification)),
      ]));
    }
    if (resolved) {
      if (p.note) kids.push(h("div", { class: "muted", text: "note: " + String(p.note) }));
      if (p.decidedAt) kids.push(h("div", { class: "faint", text: new Date(p.decidedAt).toISOString() }));
    } else {
      kids.push(h("div", { class: "row", style: "margin-top:var(--s3)" }, [
        Button("Approve", {
          variant: "primary",
          onClick: function () {
            approve(p.id);
          },
        }),
        Button("Deny", {
          variant: "danger",
          onClick: function () {
            denyWithReason(p);
          },
        }),
      ]));
    }
    return h("div", { class: "approval" }, kids);
  }

  async function approve(id) {
    await api.approveTool(id, "approved in the desktop UI");
    toast("Approved. The tool may now run.", "ok");
    await loadApprovals();
  }

  async function denyWithReason(p) {
    var input = h("input", { id: "deny-reason", type: "text", class: "input", placeholder: "Why is this being denied?" });
    var answer = await openModal(
      "Deny " + p.toolName + "?",
      h("div", { class: "stack" }, [
        h("p", { class: "muted", style: "margin:0", text: "The reason is recorded in the audit trail as evidence." }),
        h("label", { class: "field" }, [h("span", { text: "Reason" }), input]),
      ]),
      { confirmLabel: "Deny", cancelLabel: "Keep waiting" },
    );
    if (answer === null || answer === undefined) return;
    await api.denyTool(p.id, String(answer || "denied in the desktop UI"));
    toast("Denied. Nothing was executed.", "warn");
    await loadApprovals();
  }

  async function loadApprovals() {
    var all = await api.listPendingToolApprovals();
    state.pending = all || [];
    var pendingHost = el("approvals-pending");
    clear(pendingHost);
    if (!state.pending.length) {
      pendingHost.appendChild(
        EmptyState("Nothing is waiting. Privileged tool calls pause here until you decide."),
      );
    } else {
      state.pending.forEach(function (p) {
        pendingHost.appendChild(approvalCard(p, false));
      });
    }
    var badge = el("nav-approvals");
    if (badge) {
      badge.textContent = String(state.pending.length);
      badge.hidden = state.pending.length === 0;
    }
    // Resolved decisions are derived from the tool AUDIT trail rather than a
    // second channel: the audit already records, for every privileged
    // invocation, whether a human approved it and how it ended.
    var resolvedHost = el("approvals-resolved");
    clear(resolvedHost);
    try {
      var records = await api.listToolAudit();
      var privileged = (records || []).filter(function (r) {
        return r.permission === "write" || r.permission === "execute" || r.permission === "network";
      });
      if (privileged.length === 0) {
        resolvedHost.appendChild(EmptyState("No privileged call has been decided yet."));
        return;
      }
      privileged.slice(-20).reverse().forEach(function (r) {
        var tone = r.status === "ok" ? "ok" : r.status === "denied" || r.status === "cancelled" ? "warn" : "danger";
        resolvedHost.appendChild(
          h("div", { class: "approval" }, [
            h("div", { class: "row" }, [
              Badge(String(r.toolName)),
              Badge(String(r.permission), "info"),
              Badge(String(r.status), tone),
              r.approved ? Badge("approved by you", "warn") : Badge("not approved"),
            ]),
            h("div", { class: "mono faint", style: "margin-top:var(--s1)", text: new Date(r.ts).toISOString() }),
            h("div", { class: "muted", style: "margin-top:var(--s1)", text: "input: " + JSON.stringify(r.inputSummary || {}) }),
          ]),
        );
      });
    } catch (e) {
      resolvedHost.appendChild(EmptyState("Resolved history is unavailable in this build."));
    }
  }

  /* ==================================================================
     Runs view (M4)
     ================================================================== */

  function durationOf(run) {
    if (!run.startedAt || !run.finishedAt) return "—";
    return Math.max(0, run.finishedAt - run.startedAt) + " ms";
  }

  /** Formats a cost exactly as reported: $0 stays $0, a NaN shows as unknown. */
  function formatUsd(n) {
    var v = Number(n);
    if (v !== v) return "—";
    if (v === 0) return "$0";
    return "$" + v.toFixed(6);
  }

  function tokensOf(summary) {
    if (!summary) return "—";
    return String((summary.promptTokens || 0) + (summary.completionTokens || 0));
  }

  async function loadUsageByRun() {
    // One pull for the whole table. A failure degrades the cost column to "—"
    // instead of taking the run list down with it.
    try {
      var all = await api.getRunUsage();
      var map = {};
      (all || []).forEach(function (u) {
        map[u.runId] = u;
      });
      return map;
    } catch (e) {
      return null;
    }
  }

  async function loadRuns() {
    var host = el("runs-table");
    clear(host);
    host.appendChild(SkeletonRow(4));
    var runs = await api.listRuns();
    state.runs = runs || [];
    clear(host);
    if (state.runs.length === 0) {
      host.appendChild(EmptyState("No runs recorded yet."));
      return;
    }
    var usageByRun = await loadUsageByRun();
    var rows = state.runs.map(function (run) {
      var tone = run.status === "completed" ? "ok" : run.status === "cancelled" ? "warn" : "danger";
      var summary = usageByRun ? usageByRun[run.id] : null;
      var tr = h("tr", {
        class: "selectable",
        tabindex: "0",
        on: {
          click: function () {
            openRun(run.id);
          },
          keydown: function (ev) {
            if (ev.key === "Enter" || ev.key === " ") {
              ev.preventDefault();
              openRun(run.id);
            }
          },
        },
      }, [
        h("td", { class: "mono", text: String(run.id) }),
        h("td", null, [Badge(run.mode, "info")]),
        h("td", { text: String(run.subject || "(no subject)") }),
        h("td", null, [Badge(run.status, tone)]),
        h("td", { text: durationOf(run) }),
        h("td", { class: "mono", text: summary ? formatUsd(summary.costUsd) : "—" }),
        h("td", { class: "mono faint", text: tokensOf(summary) }),
        h("td", { class: "mono faint", text: String(run.errorCode || "—") }),
      ]);
      return tr;
    });
    host.appendChild(
      Table(["Run", "Mode", "Subject", "Status", "Duration", "Cost", "Tokens", "Error"], rows),
    );
  }

  async function openRun(id) {
    state.selectedRunId = id;
    var host = el("runs-detail");
    clear(host);
    host.appendChild(SkeletonRow(2));
    var run = await api.getRun(id);
    clear(host);
    if (!run) {
      host.appendChild(EmptyState("That run is no longer available."));
      return;
    }
    var facts = [
      ["run id", run.id],
      ["mode", run.mode],
      ["subject", run.subject || "(none)"],
      ["status", run.status],
      ["iterations", String(run.iterations)],
      ["paused for human", String(run.pausedForHuman)],
      ["escalated", String(run.escalated)],
      ["error", run.errorCode || "none"],
    ];
    var dl = h("dl", { class: "kv" }, []);
    facts.forEach(function (f) {
      dl.appendChild(h("dt", { text: f[0] }));
      dl.appendChild(h("dd", { class: "mono", text: String(f[1]) }));
    });
    var card = Panel("Run detail", [dl]);
    if (run.deliverable) {
      card.appendChild(h("h3", { text: "Deliverable", style: "margin-top:var(--s4)" }));
      card.appendChild(mono(run.deliverable));
    }
    var usage = null;
    try {
      usage = await api.getRunUsage(id);
    } catch (e) {
      usage = null;
    }
    if (usage) {
      card.appendChild(h("h3", { text: "Accounting", style: "margin-top:var(--s4)" }));
      var acctFacts = [
        ["invocations", String(usage.invocations)],
        ["cost", formatUsd(usage.costUsd)],
        ["prompt tokens", String(usage.promptTokens)],
        ["completion tokens", String(usage.completionTokens)],
        ["failed", String(usage.failed)],
      ];
      var acctDl = h("dl", { class: "kv" }, []);
      acctFacts.forEach(function (f) {
        acctDl.appendChild(h("dt", { text: f[0] }));
        acctDl.appendChild(h("dd", { class: "mono", text: String(f[1]) }));
      });
      card.appendChild(acctDl);
      if (usage.models && usage.models.length > 0) {
        card.appendChild(
          Table(
            ["Model", "Calls", "Cost", "Tokens"],
            usage.models.map(function (m) {
              return h("tr", null, [
                h("td", { class: "mono", text: String(m.modelId) }),
                h("td", { class: "mono", text: String(m.invocations) }),
                h("td", { class: "mono", text: formatUsd(m.costUsd) }),
                h("td", { class: "mono", text: tokensOf(m) }),
              ]);
            }),
          ),
        );
      }
      card.appendChild(
        h("p", {
          class: "faint",
          style: "margin:var(--s2) 0 0",
          text: "Cost comes only from the provider's own reported usage; unreported usage is exactly $0.",
        }),
      );
    }
    host.appendChild(card);
  }

  /* Diagnostic (the 7-gate pipeline, preserved from D5) ---------------- */

  var diagRunId = null;
  var diagStreamTimer = null;
  var diagStreamCursor = 0;

  function pushDiagStreamEvent(ev) {
    var host = el("diag-output");
    if (ev.kind === "text") host.textContent = (host.textContent || "") + ev.text;
    else if (ev.kind === "tool-call-delta") host.textContent = (host.textContent || "") + "\n[workflow tool fragment] ";
    else if (ev.kind === "usage") host.textContent = (host.textContent || "") + `\n[usage: ${ev.promptTokens ?? 0}+${ev.completionTokens ?? 0}]`;
    else if (ev.kind === "finish") host.textContent = (host.textContent || "") + `\n[finish${ev.finishReason ? ": " + ev.finishReason : ""}]`;
  }

  async function pollDiagStream(runId) {
    try {
      var env = await api.getWorkflowStream(runId, diagStreamCursor);
      if (!env) return;
      for (var i = 0; i < env.events.length; i++) pushDiagStreamEvent(env.events[i]);
      diagStreamCursor = env.nextIndex;
      if (env.state === "failed" && env.error) {
        var host = el("diag-output");
        if (!host.textContent.includes("[failed:")) {
          host.textContent = (host.textContent || "") + `\n[failed: ${env.error.code} — ${env.error.message}]`;
        }
      }
      if (env.state !== "running" && diagStreamTimer !== null) {
        clearInterval(diagStreamTimer);
        diagStreamTimer = null;
      }
    } catch (_e) {
      // result is authoritative; clear the UI-only interval below if the
      // renderer never sees state again.
    }
  }

  function stopDiagStreamPoll() {
    if (diagStreamTimer !== null) {
      clearInterval(diagStreamTimer);
      diagStreamTimer = null;
    }
  }

  async function runDiagnostic() {
    var out = el("diag-output");
    el("diag-cancel").disabled = false;
    text(out, "running…");
    try {
      var streaming = el("diag-stream") && el("diag-stream").checked;
      var request = {
        mode: el("diag-mode").value,
        subject: el("diag-subject").value,
        auto: el("diag-auto").checked,
      };
      if (streaming) {
        request.streaming = true;
        request.runId = diagRunId || ("diag-" + Date.now().toString(36));
        diagStreamCursor = 0;
        stopDiagStreamPoll();
        diagStreamTimer = setInterval(function () { pollDiagStream(request.runId); }, 300);
      }
      var result = await api.runDiagnostic(request);
      diagRunId = result.runId;
      text(out, result.text);
      if (result.ok) toast("Diagnostic complete.", "ok");
      else toast("Diagnostic failed: " + esc(result.errorCode || "unknown"), "danger");
    } catch (e) {
      clear(out);
      out.appendChild(ErrorPanel("DIAGNOSTIC", esc(e), null));
    } finally {
      stopDiagStreamPoll();
      el("diag-cancel").disabled = true;
      await loadRuns();
      await refreshStatus();
    }
  }

  async function cancelDiagnostic() {
    if (!diagRunId) return;
    await api.cancelRun(diagRunId);
    toast("Diagnostic cancelled; any budget reservation was released.", "warn");
    await loadRuns();
  }

  /* ==================================================================
     Tools view (M4)
     ================================================================== */

  function toolRows(tools, showModeNote) {
    if (!tools || tools.length === 0) {
      return EmptyState(showModeNote || "No tools are available.");
    }
    return Table(
      ["Tool", "Permission", "Approval", "Description"],
      tools.map(function (t) {
        return h("tr", null, [
          h("td", { class: "mono", text: t.name }),
          h("td", null, [Badge(t.permission, t.permission === "read" ? "ok" : "warn")]),
          h("td", null, [
            t.requiresApproval
              ? Badge("human approval required", "danger")
              : Badge("no approval needed", "ok"),
          ]),
          h("td", { class: "muted", text: String(t.description || "") }),
        ]);
      }),
    );
  }

  async function loadTools() {
    text(el("tools-mode"), state.mode);
    var visibleHost = el("tools-visible");
    var allHost = el("tools-all");
    clear(visibleHost);
    clear(allHost);
    visibleHost.appendChild(SkeletonRow(2));
    var visible = await api.listAgentTools(state.mode);
    clear(visibleHost);
    visibleHost.appendChild(toolRows(visible, "No tools are visible in " + state.mode + "."));
    var all = await api.listTools();
    clear(allHost);
    allHost.appendChild(toolRows(all));
  }

  /* ==================================================================
     Audit view (M4)
     ================================================================== */

  function auditMatches(rec, filter) {
    if (!filter) return true;
    return String(rec.runId || "").indexOf(filter) !== -1;
  }

  async function loadAudit() {
    var filter = (el("audit-run").value || "").trim();
    var toolHost = el("pane-tool");
    var logHost = el("pane-log");
    clear(toolHost);
    clear(logHost);
    toolHost.appendChild(SkeletonRow(3));

    var records = await api.listToolAudit();
    var filtered = (records || []).filter(function (r) {
      return auditMatches(r, filter);
    });
    clear(toolHost);
    if (filtered.length === 0) {
      toolHost.appendChild(EmptyState("No tool invocations recorded yet."));
    } else {
      var rows = filtered.slice(-200).reverse().map(function (r) {
        var tone = r.status === "ok" ? "ok" : r.status === "denied" || r.status === "cancelled" ? "warn" : "danger";
        return h("tr", null, [
          h("td", { class: "faint", text: new Date(r.ts).toISOString().slice(11, 19) }),
          h("td", { class: "mono", text: String(r.toolName) }),
          h("td", null, [Badge(String(r.permission), "info")]),
          h("td", null, [Badge(String(r.status), tone)]),
          h("td", null, [r.approved ? Badge("approved", "warn") : Badge("not approved")]),
          h("td", { class: "mono faint", text: JSON.stringify(r.inputSummary || {}) }),
          h("td", { class: "faint", text: String(r.justification || "—") }),
        ]);
      });
      toolHost.appendChild(
        Table(["Time", "Tool", "Class", "Status", "Approval", "Input summary", "Justification"], rows),
      );
    }

    var logs = await api.listLogs();
    clear(logHost);
    if (!logs || logs.length === 0) {
      logHost.appendChild(EmptyState("No log lines recorded yet."));
      return;
    }
    var logBox = h("pre", { class: "code" });
    logs.slice(-300).forEach(function (l) {
      logBox.appendChild(
        document.createTextNode(
          new Date(l.ts).toISOString() + " [" + l.level + "] " + l.msg + "\n",
        ),
      );
    });
    logHost.appendChild(logBox);
  }

  /* ==================================================================
     Models view (M4)
     ================================================================== */

  async function loadModels() {
    var host = el("models-posture");
    clear(host);
    host.appendChild(SkeletonRow(2));
    var models = await api.listModels();
    var posture = await api.getSelectionPosture();
    clear(host);
    var postureFacts = [
      ["egress", String(posture.egress)],
      ["spend budget", String(posture.budgetUsd) + " USD"],
      ["cost policy", String(posture.policy)],
    ];
    var dl = h("dl", { class: "kv" }, []);
    postureFacts.forEach(function (f) {
      dl.appendChild(h("dt", { text: f[0] }));
      dl.appendChild(h("dd", null, [Badge(String(f[1]), f[0] === "egress" ? "danger" : "info")]));
    });
    host.appendChild(h("h3", { text: "Selection posture" }));
    host.appendChild(dl);
    host.appendChild(h("p", { class: "muted", style: "margin:var(--s3) 0 0", text: String(posture.note || "") }));
    host.appendChild(
      h("p", { class: "faint", style: "margin:var(--s2) 0 0", text: "These bounds are frozen. This view reports them; it does not offer to change them." }),
    );

    var providersHost = el("models-providers");
    clear(providersHost);
    var providers = await api.listModelProviders();
    if (!providers || providers.length === 0) {
      providersHost.appendChild(
        EmptyState("No user provider registered. Settings → Model providers adds one; the frozen posture above is unchanged until then."),
      );
    } else {
      providers.forEach(function (p) {
        var credBadge =
          p.credentialPresent === null
            ? Badge("no key needed", "ok")
            : p.credentialPresent
              ? Badge("key present", "ok")
              : Badge("key missing", "danger");
        providersHost.appendChild(
          h("div", { class: "card card-pad row" }, [
            h("div", { class: "grow stack" }, [
              h("span", { class: "mono", text: p.displayName + "  " + p.id }),
              h("span", { class: "muted mono", text: p.endpoint + " · " + (p.models || []).join(", ") }),
            ]),
            Badge(String(p.locality), p.locality === "local" ? "ok" : "warn"),
            Badge(String(p.costClass), "ok"),
            credBadge,
            p.registered ? Badge("registered", "ok") : Badge("not loaded", "danger"),
          ]),
        );
      });
    }

    var tableHost = el("models-table");
    clear(tableHost);
    if (!models || models.length === 0) {
      tableHost.appendChild(EmptyState("The catalogue is empty."));
      return;
    }
    tableHost.appendChild(
      Table(
        ["Model", "Provider", "Locality", "Cost", "Lifecycle", "Tools", "Selectable"],
        models.map(function (m) {
          var selectable = m.enabled === true && m.available === true && m.fixed !== true;
          return h("tr", { class: selectable ? "" : "dim" }, [
            h("td", { text: m.displayName + "  " + m.id }),
            h("td", { class: "mono", text: String(m.provider) }),
            h("td", null, [Badge(String(m.locality), String(m.locality) === "local" ? "ok" : "warn")]),
            h("td", null, [Badge(String(m.costClass), "ok")]),
            h("td", null, [Badge(String(m.status), "info")]),
            h("td", { text: m.tools ? "yes" : "no" }),
            h("td", null, [selectable ? Badge("yes", "ok") : Badge("no", "danger")]),
          ]);
        }),
      ),
    );
  }

  /* ==================================================================
     Workspace view (M5)
     ================================================================== */

  async function loadWorkspace() {
    var host = el("workspace-roots");
    clear(host);
    host.appendChild(SkeletonRow(2));
    var roots = await api.listWorkspaceRoots();
    clear(host);
    if (!roots || roots.length === 0) {
      host.appendChild(
        EmptyState("No workspace folder is open. Every tool call is refused until you add one."),
      );
      return;
    }
    roots.forEach(function (root) {
      host.appendChild(
        h("div", { class: "card card-pad row" }, [
          h("span", { class: "mono grow", text: root }),
          Button("Remove", {
            small: true,
            variant: "danger",
            onClick: function () {
              removeRoot(root);
            },
          }),
        ]),
      );
    });
  }

  async function addRoot() {
    var result = await api.pickWorkspaceRoot();
    if (result && result.added) toast("Workspace added.", "ok");
    else if (result && result.chosen) toast("That folder is already a workspace.", "warn");
    else toast("No folder selected.", "warn");
    await loadWorkspace();
    await refreshStatus();
  }

  async function removeRoot(root) {
    var roots = await api.listWorkspaceRoots();
    var next = (roots || []).filter(function (r) {
      return r !== root;
    });
    if (next.length === roots.length) return;
    var answer = await openModal(
      "Remove this workspace?",
      h("div", { class: "stack" }, [
        h("p", { class: "muted", style: "margin:0", text: "Tools will no longer be able to touch this directory." }),
        mono(root),
      ]),
      { confirmLabel: "Remove", cancelLabel: "Keep" },
    );
    if (!answer) return;
    await api.patchSettings({ workspaceRoots: next });
    toast("Workspace removed.", "warn");
    await loadWorkspace();
    await refreshStatus();
  }

  /* ==================================================================
     Settings view (M5)
     ================================================================== */

  async function loadSettings() {
    var credHost = el("settings-credentials");
    clear(credHost);
    credHost.appendChild(SkeletonRow(2));

    var names = await api.listCredentialNames();
    clear(credHost);
    if (!names || names.length === 0) {
      credHost.appendChild(EmptyState("No credentials stored."));
    } else {
      names.forEach(function (name) {
        credHost.appendChild(
          h("div", { class: "card card-pad row" }, [
            h("span", { class: "mono grow", text: name }),
            Button("Replace", {
              small: true,
              onClick: function () {
                setCredential(name);
              },
            }),
            Button("Delete", {
              small: true,
              variant: "danger",
              onClick: function () {
                deleteCredential(name);
              },
            }),
          ]),
        );
      });
    }
    credHost.appendChild(
      Button("Add credential", {
        onClick: function () {
          setCredential(null);
        },
      }),
    );

    var usageHost = el("settings-usage");
    clear(usageHost);
    var totals = await api.getUsageTotals();
    usageHost.appendChild(
      Table(
        ["Invocations", "Total cost (USD)", "Total tokens"],
        [h("tr", null, [
          h("td", { class: "mono", text: String(totals.invocations) }),
          h("td", { class: "mono", text: String(totals.totalCostUsd) }),
          h("td", { class: "mono", text: String(totals.totalTokens) }),
        ])],
      ),
    );

    var budgetHost = el("settings-budget");
    clear(budgetHost);
    var budget = await api.getBudget();
    budgetHost.appendChild(h("h3", { text: "Budget" }));
    budgetHost.appendChild(mono(JSON.stringify(budget, null, 2)));

    var frozenHost = el("settings-frozen");
    clear(frozenHost);
    var frozen = await api.getFrozenDefaults();
    frozenHost.appendChild(mono(JSON.stringify(frozen, null, 2)));

    var warnHost = el("settings-provider-warnings");
    clear(warnHost);
    var warnings = await api.getProviderWarnings();
    (warnings || []).forEach(function (w) {
      warnHost.appendChild(h("div", { class: "card card-pad row" }, [Badge("skipped", "warn"), h("span", { class: "grow", text: w })]));
    });

    var providersHost = el("settings-providers");
    clear(providersHost);
    var settings = await api.getSettings();
    var providers = (settings && settings.providers) || [];
    if (providers.length === 0) {
      providersHost.appendChild(EmptyState("No providers registered. The engine only ever reaches the built-in local models."));
    } else {
      providers.forEach(function (p) {
        providersHost.appendChild(
          h("div", { class: "card card-pad row" }, [
            h("div", { class: "grow stack" }, [
              h("span", { class: "mono", text: p.id + (p.displayName ? " — " + p.displayName : "") }),
              h("span", { class: "muted mono", text: p.endpoint + " · " + (p.models || []).map(function (m) { return m.id; }).join(", ") }),
            ]),
            Button("Remove", {
              small: true,
              variant: "danger",
              onClick: function () {
                removeProvider(p.id);
              },
            }),
          ]),
        );
      });
    }
    providersHost.appendChild(
      Button("Add provider", {
        onClick: function () {
          addProvider();
        },
      }),
    );
  }

  async function addProvider() {
    var idInput = h("input", { id: "pv-id", type: "text", class: "input", placeholder: "e.g. ollama" });
    var endpointInput = h("input", { id: "pv-endpoint", type: "text", class: "input", placeholder: "http://127.0.0.1:11434/v1" });
    var keyInput = h("input", { id: "pv-keyenv", type: "text", class: "input", placeholder: "env var name, or empty for a local server" });
    var modelsInput = h("input", { id: "pv-models", type: "text", class: "input", placeholder: "llama3, qwen2.5 (comma-separated)" });
    const testOut = h("div", { class: "muted mono", text: "" });
    var answer = await openModal(
      "Add a model provider",
      h("div", { class: "stack" }, [
        h("p", { class: "muted", style: "margin:0", text: "A key travels only as an environment-variable name — the value is read at call time by the engine, never stored here." }),
        h("label", { class: "field" }, [h("span", { text: "Id" }), idInput]),
        h("label", { class: "field" }, [h("span", { text: "Endpoint" }), endpointInput]),
        h("label", { class: "field" }, [h("span", { text: "Key env var" }), keyInput]),
        h("label", { class: "field" }, [h("span", { text: "Models" }), modelsInput]),
        Button("Test config", {
          small: true,
          onClick: async function () {
            testOut.textContent = "testing…";
            try {
              var raw = {
                id: String(idInput.value || "").trim(),
                displayName: String(idInput.value || "").trim(),
                endpoint: String(endpointInput.value || "").trim(),
                apiKeyEnv: String(keyInput.value || "").trim() || null,
                models: String(modelsInput.value || "")
                  .split(",")
                  .map(function (s) { return s.trim(); })
                  .filter(function (s) { return s.length > 0; })
                  .map(function (m) { return { id: m, displayName: m }; }),
              };
              var probe = await api.validateProviderConfig(raw);
              testOut.textContent = probe.ok ? `OK: ${probe.detail}` : `FAILED${probe.code ? " (" + probe.code + ")" : ""}: ${probe.detail}`;
            } catch (e) {
              testOut.textContent = String(e);
            }
          },
        }),
        testOut,
      ]),
      { confirmLabel: "Add" },
    );
    if (!answer) return;
    var id = String(idInput.value || "").trim();
    var endpoint = String(endpointInput.value || "").trim();
    var keyEnv = String(keyInput.value || "").trim();
    var modelIds = String(modelsInput.value || "")
      .split(",")
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
    if (!id || !endpoint || modelIds.length === 0) {
      toast("A provider needs an id, an endpoint, and at least one model.", "warn");
      return;
    }
    var settings = await api.getSettings();
    var existing = (settings && settings.providers) || [];
    var next = existing.concat([
      {
        id: id,
        displayName: id,
        endpoint: endpoint,
        apiKeyEnv: keyEnv || null,
        models: modelIds.map(function (m) { return { id: m, displayName: m }; }),
      },
    ]);
    var saved = await api.patchSettings({ providers: next });
    if ((saved.providers || []).length === existing.length) {
      toast("That provider was rejected (see above) — nothing was added.", "warn");
    } else {
      toast("Provider saved — applied immediately.", "ok");
    }
    await loadSettings();
  }

  async function removeProvider(id) {
    var answer = await openModal(
      "Remove " + id + "?",
      h("p", { class: "muted", style: "margin:0", text: "Its models leave the catalogue immediately." }),
      { confirmLabel: "Remove", cancelLabel: "Keep" },
    );
    if (!answer) return;
    var settings = await api.getSettings();
    var existing = (settings && settings.providers) || [];
    await api.patchSettings({
      providers: existing.filter(function (p) {
        return p.id !== id;
      }),
    });
    toast("Provider removed — applied immediately.", "warn");
    await loadSettings();
  }

  async function setCredential(existingName) {
    var nameInput = h("input", { id: "cred-name", type: "text", class: "input", value: existingName || "", placeholder: "name" });
    var valueInput = h("input", { id: "cred-value", type: "password", class: "input", placeholder: "value (write-only)" });
    var answer = await openModal(
      existingName ? "Replace " + existingName : "Add credential",
      h("div", { class: "stack" }, [
        h("p", { class: "muted", style: "margin:0", text: "The value is encrypted by the OS and can never be read back — not by this app, not by anyone." }),
        h("label", { class: "field" }, [h("span", { text: "Name" }), nameInput]),
        h("label", { class: "field" }, [h("span", { text: "Value" }), valueInput]),
      ]),
      { confirmLabel: "Save" },
    );
    if (!answer) return;
    var name = String(nameInput.value || "").trim();
    var value = String(valueInput.value || "");
    if (!name || !value) {
      toast("A credential needs both a name and a value.", "warn");
      return;
    }
    await api.setCredential(name, value);
    // Overwrite the local copy immediately: the value has travelled to the OS
    // and this page keeps no reference to it.
    valueInput.value = "";
    toast("Credential stored.", "ok");
    await loadSettings();
  }

  async function deleteCredential(name) {
    var answer = await openModal(
      "Delete " + name + "?",
      h("p", { class: "muted", style: "margin:0", text: "The stored value is removed. It cannot be recovered." }),
      { confirmLabel: "Delete", cancelLabel: "Keep" },
    );
    if (!answer) return;
    await api.deleteCredential(name);
    toast("Credential deleted.", "warn");
    await loadSettings();
  }

  /* ==================================================================
     Status
     ================================================================== */

  async function refreshStatus() {
    var status = await api.getSystemStatus();
    var posture = await api.getSelectionPosture();
    text(
      el("posture"),
      "egress " + posture.egress + " · budget " + posture.budgetUsd + " USD · policy " +
        posture.policy + " · runs " + status.runs + " · credentials " +
        (status.credentials || []).length,
    );
    text(
      el("sidebar-foot"),
      "Runs " + status.runs + "\nAwaiting you " + (state.pending || []).length,
    );
  }

  /* ==================================================================
     View loading
     ================================================================== */

  var loaders = {
    agent: function () {
      renderTranscript(state.lastResult);
      syncAgentState();
    },
    runs: loadRuns,
    tools: loadTools,
    approvals: loadApprovals,
    audit: loadAudit,
    models: loadModels,
    workspace: loadWorkspace,
    settings: loadSettings,
  };

  async function refreshView(name) {
    var loader = loaders[name];
    if (loader) await loader();
  }

  /* ==================================================================
     Polling (pull-only, preserved)
     ================================================================== */

  var pollTimer = null;

  function startPolling() {
    if (pollTimer !== null) return;
    pollTimer = setInterval(function () {
      // Main never pushes. While anything is live the human must still see the
      // approval it raised, so the pending view is read back on a timer.
      if (state.view === "approvals" || state.view === "agent") {
        loadApprovals().catch(function () {});
      }
      refreshStatus().catch(function () {});
    }, 750);
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  /* ==================================================================
     Wiring
     ================================================================== */

  function setMode(mode) {
    state.mode = mode;
    MODES.forEach(function (m) {
      var btn = el("mode-" + m);
      if (btn) btn.setAttribute("aria-pressed", m === mode ? "true" : "false");
    });
    var help = el("mode-help");
    if (help) text(help, MODE_HELP[mode] || "");
    var selectNode = el("settings-mode");
    if (selectNode) selectNode.value = mode;
  }

  function wire() {
    var navItems = document.querySelectorAll(".nav-item");
    for (var i = 0; i < navItems.length; i++) {
      navItems[i].addEventListener("click", function (ev) {
        showView(ev.currentTarget.getAttribute("data-view"));
      });
    }

    ["light", "dark", "system"].forEach(function (name) {
      var btn = el("theme-" + name);
      if (btn) btn.addEventListener("click", function () {
        setTheme(name);
      });
    });

    MODES.forEach(function (mode) {
      var btn = el("mode-" + mode);
      if (btn) btn.addEventListener("click", function () {
        setMode(mode);
        if (state.view === "tools") loadTools().catch(function () {});
      });
    });

    el("agent-run").addEventListener("click", runAgent);
    el("agent-cancel").addEventListener("click", cancelAgent);
    el("first-run-local")?.addEventListener("click", function () {
      state.firstRunDismissed = true;
      var card = el("agent-first-run");
      if (card && card.style) card.style.display = "none";
      el("agent-prompt").focus();
    });
    el("first-run-dismiss")?.addEventListener("click", function () {
      state.firstRunDismissed = true;
      var card = el("agent-first-run");
      if (card && card.style) card.style.display = "none";
    });
    el("first-run-provider")?.addEventListener("click", function () {
      state.firstRunDismissed = true;
      var card = el("agent-first-run");
      if (card && card.style) card.style.display = "none";
      showView("settings");
      Promise.resolve().then(async function () {
        try {
          await loadSettings();
          var addHost = document.querySelector('#settings-providers');
          if (addHost && addHost.lastElementChild && typeof addHost.lastElementChild.click === "function") {
            addHost.lastElementChild.click();
          }
        } catch (_e) {}
      });
    });
    el("agent-prompt").addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        runAgent();
      }
    });

    el("workspace-add").addEventListener("click", function () {
      addRoot().catch(function (e) {
        toast("Could not add a folder: " + esc(e), "danger");
      });
    });

    el("diag-run").addEventListener("click", function () {
      runDiagnostic();
    });
    el("diag-cancel").addEventListener("click", function () {
      cancelDiagnostic();
    });

    var themeSelect = el("settings-theme");
    if (themeSelect) themeSelect.addEventListener("change", function () {
      setTheme(themeSelect.value);
    });
    var modeSelect = el("settings-mode");
    if (modeSelect) {
      modeSelect.addEventListener("change", function () {
        setMode(modeSelect.value);
        api.patchSettings({ defaultMode: modeSelect.value });
      });
    }

    var auditRun = el("audit-run");
    if (auditRun) auditRun.addEventListener("input", function () {
      loadAudit().catch(function () {});
    });

    el("tab-tool").addEventListener("click", function () {
      selectTab("tool");
    });
    el("tab-log").addEventListener("click", function () {
      selectTab("log");
    });

    el("modal-cancel").addEventListener("click", function () {
      closeModal(null);
    });
    el("modal-confirm").addEventListener("click", function () {
      var field = el("modal-body").querySelector("input[type=text], input[type=password]");
      closeModal(field ? field.value : true);
    });
    el("modal-backdrop").addEventListener("click", function (ev) {
      if (ev.target === el("modal-backdrop")) closeModal(null);
    });

    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "Escape") return;
      var backdrop = el("modal-backdrop");
      if (backdrop && backdrop.classList.contains("open")) closeModal(null);
    });

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) stopPolling();
      else startPolling();
    });
  }

  async function init() {
    try {
      var settings = await api.getSettings();
      state.settings = settings || null;
      state.theme = (settings && settings.theme) || "system";
      state.mode = (settings && settings.defaultMode) || "INSPECT";
      state.runId = "";
    } catch (e) {
      state.theme = "system";
    }
    paintTheme();
    setMode(state.mode);
    wire();
    renderTranscript(null);
    syncAgentState();
    await refreshStatus();
    await loadApprovals();
    await loadTools();
    startPolling();
    updateFirstRunCard();
  }

  async function updateFirstRunCard() {
    var card = el("agent-first-run");
    if (!card || state.firstRunDismissed) return;
    if (!card.style) return;
    try {
      var settings = await api.getSettings();
      card.style.display = ((settings && settings.providers) || []).length === 0 ? "" : "none";
    } catch (_e) {
      card.style.display = "none";
    }
  }

  init().catch(function (e) {
    var status = el("status");
    if (status) text(status, "init failed: " + esc(e));
    var posture = el("posture");
    if (posture) text(posture, "init failed: " + esc(e));
  });
})();