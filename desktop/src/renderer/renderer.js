/**
 * Renderer (D5).
 *
 * Runs in a sandboxed page with NO Node access. Its only capability is the
 * `window.allInOne` object the preload exposes — an enumerated API. There is no
 * filesystem, no process, no engine import, and no way to read a credential
 * value back.
 *
 * This file is PLAIN JAVASCRIPT, not TypeScript: Chromium parses page scripts
 * as-is and transpiles nothing, so a `.js` file carrying type annotations is a
 * syntax error and the whole page dies. (D1 shipped it that way; D5 fixes it.)
 *
 * Updates are PULL-ONLY. There is no push channel from main; while a run is
 * live this page polls the read-only views it already holds, so nothing ever
 * arrives unsolicited.
 *
 * Security rules kept by construction:
 *   - every value rendered through `esc()` so data can never become markup;
 *   - the model's justification is shown to the human as evidence and is never
 *     used to satisfy the approval it describes — only the Approve / Deny
 *     buttons can, and they answer a request the executor raised.
 */
(function () {
  "use strict";

  var api = window.allInOne;

  function esc(v) {
    return String(v).replace(/[&<>"]/g, function (c) {
      return "&#" + c.charCodeAt(0) + ";";
    });
  }

  function el(id) {
    return document.getElementById(id);
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function text(node, str) {
    clear(node);
    node.appendChild(document.createTextNode(str));
  }

  function pre(node, value) {
    text(node, JSON.stringify(value, null, 2));
  }

  // ---------------------------------------------------------------- status

  async function refreshStatus() {
    var status = await api.getSystemStatus();
    text(
      el("status"),
      "egress: " + status.egress.kind +
        " · budget: " + JSON.stringify(status.budget) +
        " · approvals: " + status.approvals +
        " · runs: " + status.runs +
        " · credentials: " + status.credentials.length,
    );
  }

  async function refreshModels() {
    var models = await api.listModels();
    var posture = await api.getSelectionPosture();
    text(
      el("posture"),
      posture.egress + " egress · budget " + posture.budgetUsd +
        " · policy " + posture.policy + " — " + posture.note,
    );
    var tbody = el("models").querySelector("tbody");
    clear(tbody);
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      var tr = document.createElement("tr");
      if (m.fixed || !m.enabled || !m.available) tr.className = "dim";
      tr.appendChild(td(m.displayName + "  (" + m.id + ")"));
      tr.appendChild(td(m.provider));
      tr.appendChild(td(m.locality));
      tr.appendChild(td(m.costClass));
      tr.appendChild(td(m.status));
      tr.appendChild(td(m.tools ? "yes" : "no"));
      tbody.appendChild(tr);
    }
  }

  function td(str) {
    var cell = document.createElement("td");
    cell.appendChild(document.createTextNode(String(str)));
    return cell;
  }

  // ---------------------------------------------------------------- tools

  var currentMode = "INSPECT";

  async function refreshTools() {
    var mode = el("agent-mode").value;
    currentMode = mode;
    text(el("tools-mode"), mode);
    var tools = await api.listAgentTools(mode);
    var tbody = el("tools").querySelector("tbody");
    clear(tbody);
    for (var i = 0; i < tools.length; i++) {
      var t = tools[i];
      var tr = document.createElement("tr");
      tr.appendChild(td(t.name));
      tr.appendChild(td(t.permission));
      tr.appendChild(td(t.requiresApproval ? "human approval required" : "no"));
      tr.appendChild(td(t.description));
      tbody.appendChild(tr);
    }
    if (tools.length === 0) {
      var tr = document.createElement("tr");
      var cell = td("no tools are visible in " + mode);
      cell.colSpan = 4;
      tr.appendChild(cell);
      tbody.appendChild(tr);
    }
  }

  // ------------------------------------------------------- approvals (D6-minimal)

  async function refreshPending() {
    var pending = await api.listPendingToolApprovals();
    var host = el("pending");
    clear(host);
    if (pending.length === 0) {
      host.appendChild(document.createTextNode("none — no tool is waiting for a decision"));
      return;
    }
    for (var i = 0; i < pending.length; i++) {
      var p = pending[i];
      var box = document.createElement("div");
      box.className = "approval";
      var head = document.createElement("div");
      head.appendChild(document.createTextNode(p.toolName + " · " + p.permission));
      box.appendChild(head);
      var detail = document.createElement("div");
      detail.className = "muted";
      detail.appendChild(
        document.createTextNode("input: " + JSON.stringify(p.inputSummary)),
      );
      box.appendChild(detail);
      if (p.justification) {
        var why = document.createElement("div");
        why.className = "muted";
        why.appendChild(document.createTextNode("model's justification: " + p.justification));
        box.appendChild(why);
      }
      var row = document.createElement("div");
      row.className = "row";
      var approve = document.createElement("button");
      approve.textContent = "Approve";
      var deny = document.createElement("button");
      deny.textContent = "Deny";
      approve.addEventListener("click", makeAnswer(p.id, true));
      deny.addEventListener("click", makeAnswer(p.id, false));
      row.appendChild(approve);
      row.appendChild(deny);
      box.appendChild(row);
      host.appendChild(box);
    }
  }

  function makeAnswer(id, approved) {
    return async function () {
      if (approved) await api.approveTool(id, "approved in the desktop UI");
      else await api.denyTool(id, "denied in the desktop UI");
      await refreshPending();
    };
  }

  // ------------------------------------------------------------ workspace

  async function refreshRoots() {
    var roots = await api.listWorkspaceRoots();
    var ul = el("roots");
    clear(ul);
    if (roots.length === 0) {
      var li = document.createElement("li");
      li.appendChild(document.createTextNode("none configured — every tool call is refused"));
      ul.appendChild(li);
      return;
    }
    for (var i = 0; i < roots.length; i++) {
      var li = document.createElement("li");
      li.appendChild(document.createTextNode(roots[i]));
      ul.appendChild(li);
    }
  }

  // --------------------------------------------------------------- agent

  var agentRunId = null;
  var agentBusy = false;

  function renderEvent(ev) {
    var box = document.createElement("div");
    box.className = "turn " + ev.kind;
    if (ev.kind === "user") {
      box.appendChild(document.createTextNode("you: " + ev.text));
    } else if (ev.kind === "assistant") {
      box.appendChild(document.createTextNode("model: " + (ev.text || "(no text)")));
      var calls = ev.toolCalls || [];
      for (var i = 0; i < calls.length; i++) {
        var c = document.createElement("div");
        c.className = "muted";
        c.appendChild(
          document.createTextNode(
            "→ asks " + calls[i].toolName + " " + JSON.stringify(calls[i].input),
          ),
        );
        box.appendChild(c);
      }
    } else {
      var oc = ev.outcome;
      var label = "tool " + oc.toolName + ": " + (oc.ok ? "ok" : "failed (" + (oc.code || "?") + ")");
      if (oc.approved) label += " · approved by the human";
      box.appendChild(document.createTextNode(label));
      if (oc.excerpt) {
        var ex = document.createElement("div");
        ex.className = "muted";
        ex.appendChild(document.createTextNode(String(oc.excerpt).slice(0, 400)));
        box.appendChild(ex);
      }
    }
    return box;
  }

  function renderResult(result) {
    var host = el("transcript");
    var history = result.history || [];
    for (var i = 0; i < history.length; i++) host.appendChild(renderEvent(history[i]));

    var bits = [];
    bits.push("turns: " + result.turns);
    bits.push("approved edits: " + result.approvedEdits);
    if (result.pausedForHuman) bits.push("PAUSED for the human — run again on the same run id to continue");
    if (result.escalated) bits.push("ESCALATED — human intervention required");
    if (result.ok) bits.push("ok");
    else bits.push("failed" + (result.error ? ": " + result.error.code + " — " + result.error.message : ""));
    text(el("agent-state"), bits.join(" · "));
  }

  async function runAgent() {
    if (agentBusy) return;
    var prompt = el("agent-prompt").value;
    if (!prompt.trim()) {
      text(el("agent-state"), "the prompt is empty — nothing to ask the model");
      return;
    }
    agentBusy = true;
    el("agent-run").disabled = true;
    el("agent-cancel").disabled = false;
    var runId = el("agent-run-id").value.trim();
    var auto = el("agent-auto").checked;
    var mode = el("agent-mode").value;
    text(el("agent-state"), "running…");
    try {
      var result = await api.runAgent({
        runId: runId || "ui-" + Date.now().toString(36),
        prompt: prompt,
        mode: mode,
        auto: auto ? { auto: true } : undefined,
      });
      agentRunId = result.runId;
      el("agent-run-id").value = result.runId;
      renderResult(result);
      // A paused run may have a privileged request waiting: refresh immediately
      // so the human sees the approval the model asked for.
      await refreshPending();
    } catch (e) {
      text(el("agent-state"), "failed: " + esc(e));
    } finally {
      agentBusy = false;
      el("agent-run").disabled = false;
      el("agent-cancel").disabled = true;
      await refreshStatus();
    }
  }

  async function cancelAgent() {
    if (!agentRunId) return;
    await api.cancelRun(agentRunId);
    text(el("agent-state"), "cancelled by the user; any pending approval was released, never approved");
    await refreshPending();
  }

  // --------------------------------------------------------- diagnostic

  var currentRunId = null;

  async function runDiagnostic() {
    var mode = el("mode").value;
    var subject = el("subject").value;
    var auto = el("auto").checked;
    var out = el("output");
    var cancelBtn = el("cancel");
    text(out, "running…");
    cancelBtn.disabled = false;
    try {
      var result = await api.runDiagnostic({ mode: mode, subject: subject, auto: auto });
      currentRunId = result.runId;
      text(out, result.text);
    } catch (e) {
      text(out, "failed: " + esc(e));
    } finally {
      cancelBtn.disabled = true;
      await refreshAll();
    }
  }

  async function cancelDiagnostic() {
    if (!currentRunId) return;
    await api.cancelRun(currentRunId);
    await refreshAll();
  }

  // ----------------------------------------------------------------- polling

  var pollTimer = null;

  function startPolling() {
    if (pollTimer !== null) return;
    pollTimer = setInterval(function () {
      // Pull-only: main never pushes. While a run is live the human still
      // needs to see the approval it raised, so this reads it back.
      refreshPending().catch(function () {});
      refreshStatus().catch(function () {});
    }, 750);
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ------------------------------------------------------------------ init

  async function refreshAll() {
    await refreshStatus();
    await refreshModels();
    await refreshTools();
    await refreshPending();
    await refreshRoots();
    pre(el("approvals"), await api.listApprovals());
    pre(el("usage"), await api.getUsageTotals());
    pre(el("credentials"), await api.listCredentialNames());
    var logs = await api.listLogs();
    text(
      el("logs"),
      logs
        .slice(-40)
        .map(function (l) {
          return new Date(l.ts).toISOString() + " [" + l.level + "] " + l.msg;
        })
        .join("\n"),
    );
  }

  el("run").addEventListener("click", runDiagnostic);
  el("cancel").addEventListener("click", cancelDiagnostic);
  el("agent-run").addEventListener("click", runAgent);
  el("agent-cancel").addEventListener("click", cancelAgent);
  el("agent-mode").addEventListener("change", function () {
    refreshTools().catch(function () {});
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stopPolling();
    else startPolling();
  });

  refreshAll()
    .then(function () {
      startPolling();
    })
    .catch(function (e) {
      text(el("status"), "init failed: " + esc(e));
    });
})();
