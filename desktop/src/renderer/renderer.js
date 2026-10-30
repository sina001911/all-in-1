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
    var allViews = ["chat", "compare", "collab", "runs", "tools", "approvals", "audit", "models", "workspace", "artifacts", "settings"];
    allViews.forEach(function (v) {
      var view = el("view-" + v);
      if (view) view.classList.toggle("active", v === name);
    });
    // The chat-head segment (Single / Compare / Collaborate) and the composer's
    // execution-type select mirror each other and the view; all three end in
    // the same state after any one of them is used.
    syncExecTypeControls(name);
    refreshView(name).catch(function () {});
  }

  var EXEC_SEG = { chat: "mode-INSPECT", compare: "mode-COMPARE", collab: "mode-COLLAB" };

  function syncExecTypeControls(viewName) {
    var execSel = el("exec-type");
    if (execSel) {
      var inv = viewName === "chat" ? "single" : viewName === "compare" ? "compare" : viewName === "collab" ? "collab" : null;
      if (inv) execSel.value = inv;
    }
    for (var v in EXEC_SEG) {
      var btn = el(EXEC_SEG[v]);
      if (btn) btn.setAttribute("aria-pressed", v === viewName ? "true" : "false");
    }
  }

  function selectExecType(kind) {
    var sel = el("exec-type");
    if (sel) sel.value = kind;
    if (kind === "single") showView("chat");
    else if (kind === "compare") showView("compare");
    else if (kind === "collab") showView("collab");
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
    // D35: an uploaded file produces a single turn-style card directly, not
    // via the history array. Treat a top-level {body,label,contentType} as
    // an ephemeral turn so the transcript is never empty after an upload.
    if (result && result.kind === "uploaded") {
      var card = h("div", { class: "card card-pad turn turn-system" }, [
        h("div", { class: "turn-head" }, [Badge(result.label || "Upload")]),
        result.contentType
          ? h("div", { class: "mono faint", text: "type: " + result.contentType })
          : null,
        result.artifactId
          ? h("div", { class: "mono faint", text: "artifact: " + result.artifactId })
          : null,
        h("pre", { class: "code", style: "margin-top:var(--s2)" }, [result.body || ""]),
      ]);
      host.appendChild(card);
      host.scrollTop = host.scrollHeight;
      return;
    }
    // P1-6: a generated image lands as a single turn-style card, like an upload.
    if (result && result.kind === "generated") {
      var gCard = h("div", { class: "card card-pad turn turn-system" }, [
        h("div", { class: "turn-head" }, [Badge(result.label || "Generated")]),
        result.artifactId
          ? h("div", { class: "mono faint", text: "artifact: " + result.artifactId })
          : null,
      ]);
      if (result.artifactId) {
        gCard.appendChild(
          h("img", {
            src: "all-in-1:artifacts:read/" + result.artifactId,
            style: "max-width:100%;border-radius:var(--radius);margin-top:var(--s2)",
            alt: "Generated image",
          }),
        );
        // D35: a download button lets the human export the generated image
        // without leaving the app. The facade streams the bytes from the
        // content-addressed store; the renderer never sees the base path.
        gCard.appendChild(
          h("div", { class: "row", style: "margin-top:var(--s2)" }, [
            Button("Download", {
              small: true,
              onClick: function () {
                downloadArtifact(result.artifactId);
              },
            }),
          ]),
        );
      }
      host.appendChild(gCard);
      host.scrollTop = host.scrollHeight;
      return;
    }
    var history = (result && result.history) || [];
    if (history.length === 0) {
      host.appendChild(
        EmptyState("No turns yet — send a prompt above and the model's reasoning and tool activity appear here."),
      );
    }
    history.forEach(function (ev) {
      host.appendChild(renderTurn(ev));
    });
    // D29/D33: the engine reports which model ACTUALLY executed. If it is not
    // the one the human requested, say so — a substitute is never silent.
    if (result && result.model) {
      var requested = state.lastRequestedModel;
      var mismatch = !!requested && result.model !== requested;
      var row = h("div", { class: "row", style: "margin-bottom:var(--s2)" }, [
        Badge("answered by " + result.model, mismatch ? "warn" : "ok"),
      ]);
      if (mismatch) {
        row.appendChild(Badge("substituted — you requested " + requested, "warn"));
      }
      host.appendChild(row);
    }
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
    // The chat view shows state through the transcript and the composer bar;
    // there is no separate status pill in the new layout.
    var hint = el("agent-hint");
    if (hint && state.lastResult && state.lastResult.pausedForHuman) {
      text(hint, "Run again on the same run id to continue.");
    }
  }

  function renderWelcome() {
    var host = el("chat-welcome");
    clear(host);
    var wrap = h("div", { class: "welcome-hero" }, [
      h("div", { class: "welcome-sphere", attrs: { "aria-hidden": "true" } }),
      h("h1", { text: "Welcome to AI1" }),
      h("p", { class: "muted", text: "Choose a model and how you want to work. Built-in local models work offline; add a provider for more." }),
    ]);
    host.appendChild(wrap);
    var cards = h("div", { class: "welcome-cards", id: "welcome-cards" });
    var cardDefs = [
      { action: "generate", label: "Generate Image", icon: "🎨" },
      { action: "video", label: "Video Generate", icon: "🎬" },
      { action: "prompt", label: "Improve Prompt", icon: "✨" },
      { action: "dashboard", label: "Dashboard Design", icon: "📊" },
    ];
    cardDefs.forEach(function (def) {
      var btn = h("button", {
        type: "button",
        class: "welcome-card",
        attrs: { "data-action": def.action },
        title: def.label,
      });
      btn.appendChild(h("div", { class: "welcome-card-icon", attrs: { "aria-hidden": "true" }, text: def.icon }));
      btn.appendChild(h("div", { class: "welcome-card-label", text: def.label }));
      btn.addEventListener("click", function () {
        var prompt = el("agent-prompt");
        if (def.action === "generate") {
          var genBtn = el("composer-generate");
          if (genBtn) genBtn.click();
        } else if (def.action === "prompt") {
          if (prompt) { prompt.value = "Improve this prompt: "; prompt.focus(); }
        } else if (def.action === "video") {
          if (prompt) { prompt.value = "Generate a video about "; prompt.focus(); }
        } else if (def.action === "dashboard") {
          if (prompt) { prompt.value = "Design a dashboard for "; prompt.focus(); }
        }
      });
      cards.appendChild(btn);
    });
    host.appendChild(cards);
    var suggBox = h("div", { class: "welcome-suggestions" });
    var suggestions = [
      "Explain how a binary search tree works",
      "Draft a README for a CLI tool",
      "Review this function for bugs",
      "Suggest 3 ways to improve this code",
    ];
    suggestions.forEach(function (s) {
      suggBox.appendChild(
        h("button", {
          type: "button",
          text: s,
          onClick: function () {
            var ta = el("agent-prompt");
            if (ta) ta.value = s;
            ta && ta.focus();
          },
        }),
      );
    });
    host.appendChild(suggBox);
  }

  function renderChatHistory() {
    var list = el("chat-history-list");
    if (!list) return;
    clear(list);
    var search = (state.chatHistorySearch || "").toLowerCase();
    var items = (state.chatHistory || []).filter(function (item) {
      if (!search) return true;
      return (item.title || "").toLowerCase().indexOf(search) !== -1 ||
             (item.preview || "").toLowerCase().indexOf(search) !== -1;
    });
    if (items.length === 0) {
      var empty = h("div", { class: "empty", text: "No conversations yet" });
      list.appendChild(empty);
      return;
    }
    items.forEach(function (item) {
      var isActive = state.chatHistoryActive === item.id;
      var row = h("div", {
        class: "chat-history-item" + (isActive ? " active" : ""),
        attrs: { "data-id": item.id },
      });
      row.appendChild(h("div", { class: "chat-history-item-title", text: item.title || "Untitled" }));
      if (item.preview) {
        row.appendChild(h("div", { class: "chat-history-item-preview", text: item.preview }));
      }
      if (item.time) {
        row.appendChild(h("div", { class: "chat-history-item-time", text: item.time }));
      }
      row.addEventListener("click", function () {
        state.chatHistoryActive = item.id;
        renderChatHistory();
        if (item.prompt) {
          var ta = el("agent-prompt");
          if (ta) { ta.value = item.prompt; ta.focus(); }
        }
      });
      list.appendChild(row);
    });
  }

  /**
   * Model combobox (B2).
   *
   * Replaces the native `<select>` with a professional keyboard-navigable
   * combobox. The hidden `#model-select` stays synced so existing code that
   * reads `el("model-select").value` keeps working.
   */
  var modelSelector = null;

  /** Initialize the combobox once on first boot. */
  function initModelSelector() {
    if (modelSelector) return;
    modelSelector = ModelSelector();
    var cb = el("model-combobox");
    if (cb) {
      cb.addEventListener("click", function () { modelSelector.toggle(); });
      cb.addEventListener("focus", function () { modelSelector.onInputFocus(); });
    }
    var inp = el("model-input");
    if (inp) {
      inp.addEventListener("click", function () { modelSelector.toggle(); });
      inp.addEventListener("keydown", function (e) { modelSelector.handleKeydown(e); });
    }
    var searchInput = el("model-search");
    if (searchInput) {
      searchInput.addEventListener("input", function () {
        state.modelSearch = searchInput.value;
        if (modelSelector) modelSelector.setSearch(state.modelSearch);
      });
    }
    var costFilter = el("model-cost-filter");
    if (costFilter) {
      costFilter.addEventListener("click", function (ev) {
        var btn = ev.target;
        if (!btn || !btn.hasAttribute("data-cost")) return;
        state.modelCostFilter = btn.getAttribute("data-cost");
        var btns = costFilter.querySelectorAll("button");
        for (var i = 0; i < btns.length; i++) {
          btns[i].setAttribute("aria-pressed", btns[i].getAttribute("data-cost") === state.modelCostFilter ? "true" : "false");
        }
        if (modelSelector) modelSelector.setCostFilter(state.modelCostFilter);
      });
    }
    var refreshBtn = el("model-refresh");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", function () {
        refreshBtn.disabled = true;
        refreshModelCatalog().then(function () {
          toast("Models & provider status refreshed.", "ok");
        }).catch(function () {
          toast("Could not refresh the model list.", "warn");
        }).then(function () {
          refreshBtn.disabled = false;
        });
      });
    }
  }

  async function populateModelSelect() {
    state.modelSearch = "";
    var search = el("model-search");
    if (search) search.value = "";
    state.modelCostFilter = "all";
    var filter = el("model-cost-filter");
    if (filter) {
      var btns = filter.querySelectorAll("button");
      for (var i = 0; i < btns.length; i++) {
        btns[i].setAttribute("aria-pressed", btns[i].getAttribute("data-cost") === "all" ? "true" : "false");
      }
    }
    initModelSelector();
    await refreshModelCatalog();
  }

  /** Re-pull the live catalogue and provider-connection state, then re-render. */
  async function refreshModelCatalog() {
    try {
      var models = await api.listModels();
      state.modelCatalog = (models || []).filter(function (m) {
        return m.enabled === true && m.available === true;
      });
    } catch (_e) {
      state.modelCatalog = [];
    }
    if (modelSelector) modelSelector.setCatalog(state.modelCatalog);
    loadModelStatus();
  }

  /**
   * The honest connection line: how many saved providers actually registered
   * into the engine, and the frozen selection posture. Nothing here is
   * invented — it is read straight from the engine's registration state.
   */
  async function loadModelStatus() {
    var host = el("model-status");
    if (!host) return;
    clear(host);
    var posture = null;
    var providers = [];
    try { posture = await api.getSelectionPosture(); } catch (_e) { posture = null; }
    try { providers = await api.listModelProviders(); } catch (_e) { providers = []; }
    if (!Array.isArray(providers)) providers = [];
    var total = providers.length;
    var registered = 0;
    for (var i = 0; i < total; i++) if (providers[i] && providers[i].registered) registered++;
    if (total === 0) {
      host.appendChild(h("span", { text: "No providers registered — built-in local models only. " }));
    } else if (registered === 0) {
      host.appendChild(h("span", { class: "st-warn", text: total + " provider(s) saved but none connected — " }));
    } else {
      host.appendChild(h("span", { class: "st-ok", text: total + " provider(s), " + registered + " connected — " }));
    }
    if (posture) {
      host.appendChild(h("span", {
        text: "egress " + posture.egress + " · budget " + posture.budgetUsd + " USD · policy " + posture.policy,
      }));
    }
  }

  /*
   * Compare (multi-model fan-out through the facade's runMany). The state of a
   * live batch lives in `cmpBatch`: null means nothing is running, so the view
   * loader may safely rebuild; non-null means panels and timers are bound to
   * it and must survive navigation.
   */
  var cmpBatch = null;

  async function loadCompare() {
    if (cmpBatch) return; // a batch is live — do not wipe its panels or timers
    var host = el("cmp-models");
    // Remember the human's checked set so leaving and coming back does not
    // silently erase a half-prepared comparison.
    var keep = {};
    host.querySelectorAll("input[type=checkbox]").forEach(function (cb) {
      if (cb.checked) keep[cb.value] = true;
    });
    clear(host);
    host.appendChild(SkeletonRow(2));
    var models = await api.listModels();
    clear(host);
    (models || []).forEach(function (m) {
      if (m.enabled !== true || m.available !== true) return;
      var caps = (m.capabilities || []);
      var capBadges = caps.length === 0 ? ""
        : " <span class='mono faint' style='font-size:10px'>" + caps.join(", ") + "</span>";
      var cb = h("input", {
        id: "cmp-model-" + m.id.replace("/", "-"),
        type: "checkbox",
        value: m.id,
      });
      if (keep[m.id]) cb.checked = true;
      var label = h("label", { class: "check" }, [
        cb,
        document.createTextNode(" " + m.displayName + "  " + m.id + capBadges),
      ]);
      host.appendChild(h("div", null, [label]));
    });
    var results = el("cmp-results");
    clear(results);
  }

  function cmpDisplayName(modelId) {
    var known = null;
    (state.modelCatalog || []).forEach(function (m) {
      if (m.id === modelId) known = m;
    });
    return known ? known.displayName : modelId;
  }

  function cmpSlotPanel(modelId, index, runId, live) {
    var bodyKids = [];
    if (live) {
      // The live preview the per-slot stream poll writes into; the final
      // answer replaces the whole body, so it is never a duplicate tail.
      bodyKids.push(h("pre", { class: "code", id: "cmp-live-" + index, style: "white-space:pre-wrap" }, []));
    } else {
      bodyKids.push(SkeletonRow(1));
    }
    var panel = h("div", { class: "card card-pad cmp-slot", id: "cmp-slot-" + index }, [
      h("div", { class: "row" }, [
        h("div", null, [
          h("h3", { text: cmpDisplayName(modelId) }),
          h("div", { class: "mono faint", text: modelId }),
        ]),
        h("div", { class: "grow" }),
        h("span", { id: "cmp-status-" + index }, [Badge("running", "warn")]),
      ]),
      h("div", { class: "turn-body", id: "cmp-body-" + index, style: "margin-top:var(--s2)" }, bodyKids),
      h("div", { class: "row", id: "cmp-foot-" + index, style: "margin-top:var(--s2)" }, [
        h("span", { class: "mono faint", text: "run " + runId }),
        h("div", { class: "grow" }),
        Button("Cancel", {
          small: true,
          variant: "danger",
          onClick: function () {
            cancelCompareSlot(runId);
          },
        }),
      ]),
    ]);
    return panel;
  }

  async function cancelCompareSlot(runId) {
    try {
      var ok = await api.cancelRun(runId);
      toast("Cancelled " + runId + " — the other models keep running.", "warn");
      if (!ok) toast("Nothing to cancel on " + runId + " (already settled).", "info");
      await loadApprovals();
    } catch (e) {
      toast("Cancel failed: " + esc(e), "danger");
    }
  }

  async function cancelCompareAll() {
    if (!cmpBatch) return;
    for (var i = 0; i < cmpBatch.runIds.length; i++) {
      try { await api.cancelRun(cmpBatch.runIds[i]); } catch (_e) { /* the run promise is authoritative */ }
    }
    toast("All comparison slots cancelled; no pending approval was auto-approved.", "warn");
    await loadApprovals();
  }

  function stopComparePolling() {
    if (cmpBatch && cmpBatch.timers) {
      cmpBatch.timers.forEach(function (t) { clearInterval(t); });
      cmpBatch.timers = [];
    }
  }

  async function pollCompareStreams() {
    if (!cmpBatch) return;
    var batch = cmpBatch;
    // Live progress comes from getCompareProgress — it gives per-slot status
    // (ok/text/error) from the run record plus the accumulated stream frames.
    var env = null;
    try { env = await api.getCompareProgress(batch.batchId); } catch (_e) { env = null; }
    if (env && env.slots) {
      for (var i = 0; i < env.slots.length; i++) {
        renderCompareSlot(i, env.slots[i]);
      }
    }
    // Per-slot text stream is still pulled from the agent stream bridge so
    // progressive text arrives while a slot is still running. A settled slot
    // (ok is no longer null) has nothing left to stream, so skip it: the poll
    // stays cheap and the cursor is never advanced past the end of the stream.
    for (var j = 0; j < batch.runIds.length; j++) {
      var runId = batch.runIds[j];
      var settledSlot = env && env.slots[j] ? env.slots[j] : null;
      if (settledSlot && settledSlot.ok !== null) continue;
      try {
        var env2 = await api.getAgentStream(runId, batch.cursors[runId] || 0);
        if (!env2) continue;
        for (var k = 0; k < env2.events.length; k++) {
          var ev = env2.events[k];
          var live = el("cmp-live-" + j);
          if (!live) continue;
          if (ev.kind === "text") {
            batch.streamText[j] = (batch.streamText[j] || "") + ev.text;
            live.textContent = batch.streamText[j];
          }
        }
        batch.cursors[runId] = env2.nextIndex;
      } catch (_e) {
        // The runMany promise is the final word; polling must never mask it.
      }
    }
  }

  function renderCompareSlot(i, slot) {
    var statusEl = el("cmp-status-" + i);
    var body = el("cmp-body-" + i);
    var foot = el("cmp-foot-" + i);
    if (statusEl) {
      clear(statusEl);
      if (slot.ok && !slot.pausedForHuman) statusEl.appendChild(Badge("answered", "ok"));
      else if (slot.pausedForHuman) statusEl.appendChild(Badge("paused for you", "warn"));
      else if (slot.escalated) statusEl.appendChild(Badge("escalated", "warn"));
      else statusEl.appendChild(Badge(slot.error ? "failed" : "no answer", "danger"));
    }
    if (body) {
      clear(body);
      if (slot.ok && slot.text) {
        body.appendChild(mono(slot.text));
      } else if (slot.error) {
        body.appendChild(h("div", { class: "muted", text: slot.error.code + ": " + slot.error.message }));
      } else {
        body.appendChild(EmptyState("No text answer."));
      }
    }
    if (foot) {
      clear(foot);
      foot.appendChild(h("span", { class: "mono faint", text: "run " + slot.runId }));
      foot.appendChild(h("div", { class: "grow" }));
      if (slot.executedModel) {
        var mismatch = slot.executedModel !== slot.requestedModel;
        foot.appendChild(
          h("span", {
            class: mismatch ? "st-warn" : "st-ok",
            text: "executed " + slot.executedModel + (mismatch ? "  (substituted — requested " + slot.requestedModel + ")" : ""),
          }),
        );
      }
    }
  }

  async function startCompare() {
    if (cmpBatch) return; // a batch is already live — refuse a duplicate request
    var prompt = el("cmp-prompt").value;
    if (!prompt || !prompt.trim()) {
      toast("Type a prompt first.", "warn");
      return;
    }
    var checkboxes = el("cmp-models").querySelectorAll("input[type=checkbox]:checked");
    var modelIds = [];
    var seen = {};
    for (var i = 0; i < checkboxes.length; i++) {
      var v = checkboxes[i].value;
      if (!v || seen[v]) continue; // a duplicate selection is one answer asked twice
      seen[v] = true;
      modelIds.push(v);
    }
    var results = el("cmp-results");
    clear(results);
    if (modelIds.length === 0) {
      results.appendChild(EmptyState("Select at least one model above to prepare a comparison."));
      return;
    }

    var batchId = "cmp-" + Date.now().toString(36);
    var streaming = el("cmp-stream").checked;
    var concurrency = parseInt(el("cmp-concurrency").value, 10);
    var timeout = parseInt(el("cmp-timeout").value, 10);

    var runIds = modelIds.map(function (id, idx) {
      return batchId + "-" + idx;
    });
    modelIds.forEach(function (id, idx) {
      results.appendChild(cmpSlotPanel(id, idx, runIds[idx], streaming));
    });

    cmpBatch = { runIds: runIds, timers: [], cursors: {}, streamText: {} };
    var startBtn = el("compare-start");
    startBtn.disabled = true;
    var head = h("div", { class: "row card card-pad" }, [
      h("h3", { text: "Running the same prompt on " + modelIds.length + " model(s)…" }),
      h("div", { class: "grow" }),
      Button("Cancel all", { small: true, variant: "danger", onClick: cancelCompareAll }),
    ]);
    results.insertBefore(head, results.firstChild);
    if (streaming) {
      cmpBatch.timers.push(setInterval(pollCompareStreams, 400));
    }

    var payload = {
      batchId: batchId,
      prompt: prompt,
      modelIds: modelIds,
      mode: state.mode,
      streaming: streaming,
    };
    if (concurrency > 0) payload.concurrency = concurrency;
    if (timeout > 0) payload.timeoutMs = timeout;

    try {
      var res = await api.runMany(payload);
      (res || []).forEach(function (slot, idx) { renderCompareSlot(idx, slot); });
      var okCount = (res || []).filter(function (s) { return s.ok && !s.pausedForHuman; }).length;
      if (res && res.length > 0 && okCount === res.length) toast("Comparison complete — every model answered.", "ok");
      else if (okCount === 0) toast("Every comparison slot failed or paused.", "danger");
      else toast("Comparison done: " + okCount + " of " + res.length + " answered.", "warn");
    } catch (e) {
      modelIds.forEach(function (id, idx) {
        renderCompareSlot(idx, {
          requestedModel: id,
          ok: false,
          escalated: false,
          pausedForHuman: false,
          runId: runIds[idx],
          error: { code: "COMPARE_FAILED", message: String(e) },
        });
      });
      toast("Comparison failed: " + esc(e), "danger");
    } finally {
      stopComparePolling();
      cmpBatch = null;
      startBtn.disabled = false;
      if (head.parentNode) head.remove();
      await loadRuns(); await loadNavConversations();
      await refreshStatus();
    }
  }

  /**
   * Collaborate: configurable multi-model orchestration (D34).
   *
   * The human names the goal, picks every participant, the strategy, and an
   * optional synthesis model. Each participant is an independent, fully-gated
   * specialist run; the orchestrator reconciles their structured outputs.
   * Streaming reuses the workflow stream channel, frames tagged with
   * participantId so progressive text routes to the right card.
   */
  var collabRunId = null;
  var collabBusy = false;
  var collabStreamTimer = null;
  var collabProgressTimer = null;
  var collabStreamCursor = 0;

  function addCollabParticipant() {
    var host = el("collab-participants");
    if (!host) return;
    var row = h("div", { class: "collab-participant-row", role: "group", "aria-label": "Participant" }, [
      h("label", { class: "field" }, [
        h("span", { text: "provider", "data-en": "provider", "data-fa": "\u0627\u0631\u0627\u0626\u0647\u200c\u062f\u0647\u0646\u062f\u0647" }),
        h("input", { class: "input", type: "text", value: "local", "data-collab": "provider", "aria-label": "Provider" }),
      ]),
      h("label", { class: "field" }, [
        h("span", { text: "model", "data-en": "model", "data-fa": "\u0645\u062f\u0644" }),
        h("input", { class: "input", type: "text", value: "agent", "data-collab": "model", "aria-label": "Model" }),
      ]),
      h("label", { class: "field" }, [
        h("span", { text: "role", "data-en": "role", "data-fa": "\u0646\u0642\u0634" }),
        h("select", { class: "select", "data-collab": "role", "aria-label": "Role" }, [
          h("option", { value: "DEEP_REASONING" }, [h("span", { text: "deep reasoning", "data-en": "deep reasoning", "data-fa": "\u062a\u0641\u06a9\u0631 \u0639\u0645\u06cc\u0642" })]),
          h("option", { value: "CODE_REVIEWER" }, [h("span", { text: "code reviewer", "data-en": "code reviewer", "data-fa": "\u0628\u0631\u0631\u0633\u06cc\u200c\u06a9\u0646\u0646\u062f\u0647 \u06a9\u062f" })]),
          h("option", { value: "CODING_ASSISTANT" }, [h("span", { text: "coding assistant", "data-en": "coding assistant", "data-fa": "\u062f\u0633\u062a\u06cc\u0627\u0631 \u0628\u0631\u0646\u0627\u0645\u0647\u200c\u0646\u0648\u06cc\u0633\u06cc" })]),
          h("option", { value: "FAST_TASK" }, [h("span", { text: "fast task", "data-en": "fast task", "data-fa": "\u0648\u0638\u06cc\u0641\u0647 \u0633\u0631\u06cc\u0639" })]),
          h("option", { value: "VISION" }, [h("span", { text: "vision", "data-en": "vision", "data-fa": "\u0628\u06cc\u0646\u0627\u06cc\u06cc" })]),
          h("option", { value: "VISUAL_QA" }, [h("span", { text: "visual qa", "data-en": "visual qa", "data-fa": "\u0628\u0627\u0632\u0631\u0633\u06cc \u0628\u0635\u0631\u06cc" })]),
        ]),
      ]),
      h("label", { class: "field" }, [
        h("span", { text: "its own task", "data-en": "its own task", "data-fa": "\u0648\u0638\u06cc\u0641\u0647 \u0627\u062e\u062a\u0635\u0627\u0635\u06cc" }),
        h("input", { class: "input", type: "text", placeholder: "critique the design", "data-ph-en": "critique the design", "data-ph-fa": "\u0637\u0631\u0627\u062d\u06cc \u0631\u0627 \u0628\u0631\u0631\u0633\u06cc \u06a9\u0646\u06cc\u062f", "data-collab": "task", "aria-label": "Participant task" }),
      ]),
      h("button", {
        type: "button",
        class: "btn-remove",
        title: "remove this participant",
        "aria-label": "Remove participant",
        on: {
          click: function () {
            var rows = host.querySelectorAll(".collab-participant-row");
            if (rows.length > 2) host.removeChild(row);
          },
        },
      }, [h("span", { text: "\u00d7", class: "faint" })]),
    ]);
    host.appendChild(row);
  }

  function readCollabParticipants() {
    var host = el("collab-participants");
    if (!host) return [];
    var rows = host.querySelectorAll(".collab-participant-row");
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      out.push({
        id: "p" + (i + 1),
        provider: rows[i].querySelector('[data-collab="provider"]').value.trim(),
        modelId: rows[i].querySelector('[data-collab="model"]').value.trim(),
        role: rows[i].querySelector('[data-collab="role"]').value,
        task: rows[i].querySelector('[data-collab="task"]').value.trim(),
      });
    }
    return out;
  }

  async function loadCollab() {
    var host = el("collab-participants");
    if (host && host.querySelectorAll(".collab-participant-row").length === 0) {
      addCollabParticipant();
      addCollabParticipant();
    }
    var result = el("collab-result");
    if (result) result.style.display = "none";
    var cards = el("collab-participant-cards");
    if (cards) cards.style.display = "none";
    var dis = el("collab-disagreements");
    if (dis) dis.style.display = "none";
    // Load recent collaboration runs for quick resumption.
    await loadRecentCollabs();
  }

  async function loadRecentCollabs() {
    var host = el("collab-recent");
    if (!host) return;
    clear(host);
    try {
      var runs = await api.listRuns();
      var collabs = [];
      if (runs) {
        for (var i = 0; i < runs.length; i++) {
          if (runs[i].kind === "collab") collabs.push(runs[i]);
        }
      }
      if (collabs.length === 0) {
        host.appendChild(h("p", { class: "muted", text: "No previous collaborations." }));
        return;
      }
      for (var j = 0; j < Math.min(collabs.length, 5); j++) {
        var r = collabs[j];
        var tone = r.status === "completed" ? "ok" : r.status === "cancelled" ? "warn" : "danger";
        var row = h("div", { class: "row", style: "gap:var(--s2);align-items:center" }, [
          Badge(r.status, tone),
          h("span", { class: "mono", text: r.id }),
          h("span", { class: "grow", text: r.subject || "" }),
          Button(r.ok ? "Review" : "Retry", {
            small: true,
            variant: r.ok ? "ghost" : "primary",
            onClick: function (id) {
              return function () { loadPreviousCollab(id); };
            }(r.id),
          }),
        ]);
        host.appendChild(row);
      }
      if (collabs.length > 5) {
        host.appendChild(h("p", { class: "muted faint", text: ("Showing 5 of " + collabs.length + " collaborations.") }));
      }
    } catch (_e) { /* degrade gracefully */ }
  }

  function stopCollabStreamPoll() {
    if (collabStreamTimer !== null) {
      clearInterval(collabStreamTimer);
      collabStreamTimer = null;
    }
  }

  function stopCollabProgressPoll() {
    if (collabProgressTimer !== null) {
      clearInterval(collabProgressTimer);
      collabProgressTimer = null;
    }
  }

  function pushCollabStreamEvent(ev) {
    if (!ev || !ev.participantId) return;
    var cards = el("collab-participant-cards");
    if (!cards) return;
    var card = cards.querySelector('[data-participant="' + ev.participantId + '"]');
    if (!card) return;
    var live = card.querySelector(".collab-live");
    if (!live) return;
    if (ev.kind === "text") live.textContent += ev.text;
    else if (ev.kind === "tool-call-delta") live.textContent += "\n[tool fragment]";
    else if (ev.kind === "usage") live.textContent += "\n[usage " + (ev.promptTokens || 0) + "+" + (ev.completionTokens || 0) + "]";
    else if (ev.kind === "finish") live.textContent += "\n[finish" + (ev.finishReason ? ": " + ev.finishReason : "") + "]";
  }

  async function pollCollabStream() {
    if (!collabRunId) return;
    try {
      var env = await api.getWorkflowStream(collabRunId, collabStreamCursor);
      if (!env) return;
      for (var i = 0; i < env.events.length; i++) pushCollabStreamEvent(env.events[i]);
      collabStreamCursor = env.nextIndex;
      if (env.state !== "running") stopCollabStreamPoll();
    } catch (_e) {
      // The runCollab promise is the final word; polling must never mask it.
    }
  }

  // D35: pull-only collab progress. While a collab runs, each participant card
  // shows live status from the progress endpoint instead of a frozen "running"
  // badge. The runCollab promise is the final word; this is a read-only mirror.
  async function pollCollabProgress() {
    if (!collabRunId) return;
    try {
      var env = await api.getCollabProgress(collabRunId);
      if (!env || !env.participants) return;
      var cards = el("collab-participant-cards");
      if (!cards) return;
      for (var i = 0; i < env.participants.length; i++) {
        var p = env.participants[i];
        var card = cards.querySelector('[data-participant="' + p.participantId + '"]');
        if (!card) continue;
        var badge = card.querySelector(".badge");
        if (badge) {
          badge.textContent = p.status || "running";
          badge.className = "badge " + (p.status === "completed" ? "ok"
            : p.status === "failed" ? "danger" : "warn");
        }
        var live = card.querySelector(".collab-live");
        if (live && p.text) {
          if (live.textContent !== p.text) live.textContent = p.text;
        }
      }
    } catch (_e) {
      // Pull-only; never mask the runCollab promise.
    }
  }

  async function cancelCollab() {
    if (!collabRunId) return;
    await api.cancelRun(collabRunId);
    toast("Collaboration cancelled; any budget reservation was released.", "warn");
    collabRunId = null;
    await loadRuns(); await loadNavConversations();
  }

  /**
   * Load a previous collab run into the UI for review or resumption.
   * Reads the persisted run record and its stream events, then reconstructs
   * the participant cards and result display.
   */
  async function loadPreviousCollab(runId) {
    var run = await api.getRun(runId);
    if (!run) {
      toast("Run not found.", "danger");
      return;
    }
    if (run.kind !== "collab") {
      toast("Not a collaboration run.", "warn");
      return;
    }
    // Restore the task and basic fields.
    var taskEl = el("collab-task");
    if (taskEl) taskEl.value = run.subject || "";
    // Load participant cards from the stream.
    var cards = el("collab-participant-cards");
    if (cards) {
      clear(cards);
      cards.style.display = "";
      try {
        var env = await api.getWorkflowStream(runId, 0);
        if (env && env.events) {
          // Replay events to reconstruct participant states.
          var participantStates = {};
          for (var i = 0; i < env.events.length; i++) {
            var ev = env.events[i];
            if (ev && ev.participantId) {
              if (!participantStates[ev.participantId]) {
                participantStates[ev.participantId] = { text: "", settled: false, error: null };
              }
              var st = participantStates[ev.participantId];
              if (ev.kind === "text") st.text += ev.text;
              else if (ev.kind === "finish") {
                // A finish frame is authoritative: the participant is settled,
                // whatever the reason. Absent a finish frame the card must not
                // claim a state the replay never established.
                st.settled = true;
                st.error = ev.finishReason === "stop" ? null : (ev.error || "finished: " + ev.finishReason);
              }
            }
          }
          // Build cards from replayed state.
          var ids = Object.keys(participantStates);
          for (var j = 0; j < ids.length; j++) {
            var pid = ids[j];
            var st = participantStates[pid];
            cards.appendChild(
              h("div", { class: "collab-step" + (st.settled ? " done" : ""), "data-participant": pid, role: "listitem", "aria-label": "Participant " + pid }, [
                h("div", { class: "collab-step-head" }, [
                  h("span", { class: "collab-step-num", text: String(j + 1) }),
                  h("div", { class: "collab-step-roles" }, [
                    h("span", { class: "collab-step-role", text: pid }),
                  ]),
                  h("div", { class: "grow" }),
                  Badge(st.settled ? "settled" : (st.error ? "error" : "in flight"), st.settled ? "ok" : (st.error ? "danger" : "warn")),
                ]),
                h("pre", { class: "code collab-live", "aria-live": "polite" }, [h("span", { text: st.text })]),
              ]),
            );
          }
        }
      } catch (_e) { /* degrade gracefully */ }
    }
    // Show the result if available.
    var resultCard = el("collab-result");
    if (resultCard) {
      resultCard.style.display = "";
      var resultText = el("collab-result-text");
      if (resultText) text(resultText, run.deliverable || "(no result available)");
    }
    var disCard = el("collab-disagreements");
    if (disCard) disCard.style.display = "none";
    toast("Loaded collaboration: " + runId, "ok");
  }

  function renderCollabParticipantCards(participants) {
    var cards = el("collab-participant-cards");
    if (!cards) return;
    clear(cards);
    cards.style.display = "";
    for (var i = 0; i < participants.length; i++) {
      var p = participants[i];
      var stateClass = p.ok ? "done" : "error";
      var badge = p.ok
        ? Badge("settled", "ok")
        : Badge((p.error && p.error.code) || "failed", "danger");
      var bodyText = p.ok
        ? (p.text || "")
        : ((p.error && p.error.message) || "failed") + ((p.error && p.error.code) ? " (" + p.error.code + ")" : "");
      cards.appendChild(
        h("div", { class: "collab-step " + stateClass, "data-participant": p.participant.id, role: "listitem", "aria-label": "Participant " + (i + 1) + ": " + p.participant.role }, [
          h("div", { class: "collab-step-head" }, [
            h("span", { class: "collab-step-num", text: String(i + 1) }),
            h("div", { class: "collab-step-roles" }, [
              h("span", { class: "collab-step-role", text: p.participant.role, "data-en": p.participant.role, "data-fa": p.participant.role }),
              h("span", { class: "collab-step-role", text: p.participant.provider + "/" + p.participant.modelId }),
            ]),
            h("div", { class: "grow" }),
            badge,
          ]),
          h("pre", { class: "code collab-live", "aria-live": "polite" }, [h("span", { text: bodyText })]),
        ]),
      );
    }
  }

  function renderCollabDisagreements(result) {
    var host = el("collab-disagreements");
    if (!host) return;
    clear(host);
    var ds = result.disagreements;
    if (!ds || ds.length === 0) { host.style.display = "none"; return; }
    host.style.display = "";
    host.appendChild(h("h3", null, [h("span", { text: "Disagreements", "data-en": "Disagreements", "data-fa": "اختلافات" })]));
    for (var i = 0; i < ds.length; i++) {
      var d = ds[i];
      host.appendChild(
        h("div", { class: "row", role: "listitem", "aria-label": "Disagreement: " + d.field }, [
          Badge(d.between.join(" vs "), "warn"),
          h("span", { class: "mono", text: d.field }),
          h("span", { class: "faint", text: d.a + " vs " + d.b }),
          h("div", { class: "grow" }),
          Badge(d.resolution, d.resolution === "unresolved" ? "danger" : "ok"),
        ]),
      );
    }
  }

  async function renderCollabResult(result) {
    var card = el("collab-result");
    if (!card) return;
    card.style.display = "";
    var outText = el("collab-result-text");
    if (result.synthesis && result.synthesis.text) {
      text(outText, result.synthesis.text);
    } else {
      var parts = result.participants
        .filter(function (p) { return p.ok && p.text; })
        .map(function (p) { return "[" + p.participant.id + "] " + p.text; });
      text(outText, parts.length ? parts.join("\n\n") : "(no settled output)");
    }
    var contribs = el("collab-contribs");
    clear(contribs);
    try {
      var usage = await api.getRunUsage(result.runId);
      if (usage && usage.models && usage.models.length > 0) {
        var rows = usage.models.map(function (m) {
          return [
            h("span", { class: "mono", text: m.modelId }),
            Badge("\u00d7" + m.invocations, "info"),
          ];
        });
        var cost = usage.costUsd || 0;
        rows.push([
          Badge("run cost " + cost.toLocaleString() + " USD", cost > 0 ? "warn" : "ok"),
          h("span", { class: "faint", text: "charged to the budget ledger", "data-en": "charged to the budget ledger", "data-fa": "\u0628\u0647 \u0634\u0645\u0627\u0631\u06af\u0627\u0646 \u0628\u0648\u062f\u062c\u0647 \u062a\u0639\u0644\u0642 \u062f\u0627\u0631\u062f" }),
        ]);
        contribs.appendChild(Table(["Model", "Invocations"], rows.map(function (r) {
          return h("tr", null, r.map(function (c) { return h("td", null, [c]); }));
        })));
      }
    } catch (_e) { /* usage stays coarse; the participant cards carry the answers */ }
  }

  async function startCollab() {
    if (collabBusy) return;
    var task = el("collab-task").value;
    if (!task || !task.trim()) {
      toast("Describe a goal first.", "warn");
      return;
    }
    var participants = readCollabParticipants();
    if (participants.length < 2) {
      toast("At least two participants are required.", "warn");
      return;
    }
    for (var j = 0; j < participants.length; j++) {
      if (!participants[j].provider || !participants[j].modelId || !participants[j].task) {
        toast("Every participant needs a provider, a model, and its own task.", "warn");
        return;
      }
    }
    var mode = el("collab-mode").value;
    if (mode !== "INSPECT" && mode !== "SUGGEST" && mode !== "BUILD") mode = "INSPECT";
    var strategy = el("collab-strategy").value;
    var streaming = el("collab-stream").checked;

    var request = {
      task: task.trim(),
      participants: participants,
      strategy: strategy,
      mode: mode,
    };
    var synthProvider = el("collab-synth-provider").value.trim();
    var synthModel = el("collab-synth-model").value.trim();
    if (synthProvider && synthModel) {
      request.synthesis = { provider: synthProvider, modelId: synthModel };
    }

    collabRunId = "collab-" + Date.now().toString(36);
    request.runId = collabRunId;

    collabBusy = true;
    var startBtn = el("collab-start");
    startBtn.disabled = true;

    var cards = el("collab-participant-cards");
    clear(cards);
    cards.style.display = "";
    for (var i = 0; i < participants.length; i++) {
      cards.appendChild(
        h("div", { class: "collab-step running", "data-participant": participants[i].id }, [
          h("div", { class: "collab-step-head" }, [
            h("span", { class: "collab-step-num", text: String(i + 1) }),
            h("div", { class: "collab-step-roles" }, [
              h("span", { class: "collab-step-role", text: participants[i].role }),
              h("span", { class: "collab-step-role", text: participants[i].provider + "/" + participants[i].modelId }),
            ]),
            h("div", { class: "grow" }),
            Badge("running", "warn"),
          ]),
          h("pre", { class: "code collab-live" }, []),
        ]),
      );
    }

    var disCard = el("collab-disagreements");
    if (disCard) disCard.style.display = "none";

    if (streaming) {
      request.streaming = true;
      collabStreamCursor = 0;
      stopCollabStreamPoll();
      collabStreamTimer = setInterval(pollCollabStream, 400);
    }
    // D35: live per-participant progress, independent of streaming.
    collabProgressTimer = setInterval(pollCollabProgress, 600);

    try {
      var result = await api.runCollab(request);
      if (result.ok) {
        renderCollabParticipantCards(result.participants);
        renderCollabDisagreements(result);
        await renderCollabResult(result);
        toast("Collaboration complete.", "ok");
      } else {
        var errMsg = (result.error && result.error.message) || (result.error && result.error.code) || "unknown";
        toast("Collaboration stopped: " + errMsg, "danger");
      }
      collabRunId = null;
    } catch (e) {
      clear(cards);
      cards.style.display = "";
      cards.appendChild(ErrorPanel("COLLABORATION", esc(e), null));
    } finally {
      stopCollabStreamPoll();
      stopCollabProgressPoll();
      collabBusy = false;
      startBtn.disabled = false;
      await loadRuns(); await loadNavConversations();
      await refreshStatus();
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
    // The composer's execution type must not be silently downgraded: choosing
    // Compare or Collaborate and pressing Send goes to the view that actually
    // runs it, carrying the prompt across instead of running one model only.
    var execType = el("exec-type") ? el("exec-type").value : "single";
    if (execType !== "single") {
      var carried = prompt;
      showView(execType);
      if (execType === "compare") {
        var cmpTa = el("cmp-prompt");
        if (cmpTa && !cmpTa.value) cmpTa.value = carried;
      } else {
        var collabTa = el("collab-task");
        if (collabTa && !collabTa.value) collabTa.value = carried;
      }
      toast("Opening " + execType + " — your prompt was carried over.", "info");
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
    var streaming = true; // exec-type is "single" here (the others redirected above)
    var streamCursor = 0;
    var streamTimer = null;
    var streamRow = null;
    var pollRunId = null; // the stream key for THIS call; never the stale global

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
        var env = await api.getAgentStream(pollRunId, streamCursor);
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
    // D26 continuation: reuse the previous run id ONLY while that run is still
    // paused for you (state.runId is kept exactly then, nothing else). A
    // completed or failed run never lends its id to the next one — otherwise
    // the next run's usage records append under a used key and one Runs row
    // silently reports two runs' spend (the D29 rule).
    var runId =
      state.runId ||
      "ui-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 46655).toString(36);
    state.activeRunId = runId;
    if (streaming) {
      pollRunId = runId;
      streamTimer = setInterval(pollStream, 300);
    }
    // D7/B2: the human's model choice. The combobox keeps the hidden
    // #model-select synced, so this reads the same value as before.
    var modelSel = el("model-select");
    var pref = null;
    if (modelSel && modelSel.value) {
      var slash = modelSel.value.indexOf("/");
      if (slash > 0) {
        pref = { provider: modelSel.value.slice(0, slash), modelId: modelSel.value.slice(slash + 1) };
      }
    }
    try {
      var result = await api.runAgent({
        runId: runId,
        prompt: prompt,
        mode: state.mode,
        streaming: streaming,
        preference: pref ? pref : undefined,
      });
      // Keep the id only while the run still waits for the human; anything
      // else starts a fresh run id next time (see the D26 note above).
      state.runId = result.pausedForHuman ? result.runId : "";
      el("agent-prompt").value = "";
      state.lastResult = result;
      state.lastRequestedModel = pref ? pref.provider + "/" + pref.modelId : null;
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
    // The in-flight run id is authoritative for a Stop; the kept-for-resume id
    // (state.runId) may point at a different, earlier paused run.
    var target = state.activeRunId || state.runId;
    if (!target) return;
    await api.cancelRun(target);
    state.activeRunId = "";
    state.runId = ""; // a cancelled run is not resumable as if it were paused
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

  /**
   * D27: agent runs and workflow runs share the table. The label says which
   * runtime a row came from, so an agent turn count is never mistaken for a
   * workflow step count. Records written before D27 have no `kind` and are
   * workflow runs.
   */
  function runKindLabel(run) {
    if (run.kind === "agent") return "agent · " + run.mode;
    return run.mode;
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
        h("td", null, [Badge(runKindLabel(run), run.kind === "agent" ? "ok" : "info")]),
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
      ["kind", runKindLabel(run)],
      ["mode", run.mode],
      ["subject", run.subject || "(none)"],
      ["status", run.status],
      [run.kind === "agent" ? "turns" : "iterations", String(run.iterations)],
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
      // D29: keep the id only while the run is still resumable. The diagnostic
      // path reuses an id to CONTINUE a paused run (D26); a completed or failed
      // run must not lend its id to the next one, or that fresh run lands on a
      // used key — its usage records append under colliding ids while the run
      // record is replaced, and one Runs row silently reports two runs' spend.
      diagRunId = result.pausedForHuman ? result.runId : null;
      text(out, result.text);
      if (result.ok) toast("Diagnostic complete.", "ok");
      else toast("Diagnostic failed: " + esc(result.errorCode || "unknown"), "danger");
    } catch (e) {
      clear(out);
      out.appendChild(ErrorPanel("DIAGNOSTIC", esc(e), null));
    } finally {
      stopDiagStreamPoll();
      el("diag-cancel").disabled = true;
      await loadRuns(); await loadNavConversations();
      await refreshStatus();
    }
  }

  async function cancelDiagnostic() {
    if (!diagRunId) return;
    await api.cancelRun(diagRunId);
    toast("Diagnostic cancelled; any budget reservation was released.", "warn");
    await loadRuns(); await loadNavConversations();
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

  /** The sidebar's workspace sub-list: the same roots the view shows, one
   *  compact row each, so an open project is reachable without the view. */
  async function loadNavWorkspaces() {
    var host = el("nav-workspaces");
    if (!host) return;
    clear(host);
    var roots = [];
    try { roots = await api.listWorkspaceRoots(); } catch (_e) { roots = []; }
    (roots || []).forEach(function (root) {
      var name = root.split(/[\\/]/).filter(Boolean).pop() || root;
      host.appendChild(
        h("button", {
          type: "button",
          class: "nav-item",
          title: root,
          onClick: function () { showView("workspace"); },
        }, [h("span", { class: "nav-label mono", text: name })]),
      );
    });
  }

  /** D35: the sidebar's conversations sub-list. Each row is a recorded run;
   *  clicking opens its detail, and the row carries rename / delete
   *  affordances so the human can curate the history without leaving chat. */
  async function loadNavConversations() {
    var host = el("nav-conversations-list");
    var countEl = el("nav-conversations");
    if (!host) return;
    clear(host);
    var runs = [];
    try { runs = await api.listRuns(); } catch (_e) { runs = []; }
    state.runs = runs || [];
    if (countEl) {
      countEl.textContent = String(state.runs.length);
      countEl.hidden = state.runs.length === 0;
    }
    if (state.runs.length === 0) {
      host.appendChild(
        h("button", { type: "button", class: "nav-item", disabled: true }, [
          h("span", { class: "nav-label faint", text: "No conversations yet" }),
        ]),
      );
      return;
    }
    // Newest first — the most recent conversation is the one the human is
    // most likely to resume.
    var sorted = state.runs.slice().sort(function (a, b) {
      return (b.finishedAt || b.startedAt || 0) - (a.finishedAt || a.startedAt || 0);
    });
    sorted.forEach(function (run) {
      var label = run.subject && run.subject.trim()
        ? run.subject
        : run.id;
      var row = h("div", { class: "nav-row" }, [
        h("button", {
          type: "button",
          class: "nav-item",
          title: "Open " + run.id,
          onClick: function () { openRun(run.id); },
        }, [
          h("span", { class: "nav-label", text: label }),
          h("span", { class: "nav-meta faint", text: run.status + " · " + runKindLabel(run) }),
        ]),
        h("button", {
          type: "button",
          class: "nav-icon",
          title: "Rename this conversation",
          "aria-label": "Rename " + run.id,
          onClick: function () { promptRenameRun(run); },
        }, [h("span", { text: "✎" })]),
        h("button", {
          type: "button",
          class: "nav-icon danger",
          title: "Delete this conversation",
          "aria-label": "Delete " + run.id,
          onClick: function () { promptDeleteRun(run); },
        }, [h("span", { text: "🗑" })]),
      ]);
      host.appendChild(row);
    });
  }

  /** D35: rename is cosmetic — the id is untouched, so the artifact store and
   *  usage ledger keep working. We ask for a name instead of editing inline so
   *  the value is validated on the facade side. */
  function promptRenameRun(run) {
    var name = window.prompt("Rename conversation", run.subject || "");
    if (name === null) return;
    api.renameRun(run.id, name.trim() || "").then(function (ok) {
      if (ok) {
        toast("Conversation renamed.", "ok");
        loadNavConversations();
        if (state.selectedRunId === run.id) loadRuns();
      } else {
        toast("Rename failed.", "danger");
      }
    }).catch(function () { toast("Rename failed.", "danger"); });
  }

  /** D35: delete removes the run record. Artifacts and the usage ledger are
   *  untouched — a deleted conversation is gone from the list but its
   *  deliverables remain downloadable by id. */
  function promptDeleteRun(run) {
    if (!window.confirm("Delete this conversation? Its artifacts stay.")) return;
    api.deleteRun(run.id).then(function (ok) {
      if (ok) {
        toast("Conversation deleted.", "ok");
        loadNavConversations();
        loadRuns();
        if (state.selectedRunId === run.id) {
          state.selectedRunId = null;
          var detail = el("runs-detail");
          if (detail) clear(detail);
        }
      } else {
        toast("Delete failed.", "danger");
      }
    }).catch(function () { toast("Delete failed.", "danger"); });
  }

  async function loadWorkspace() {
    var host = el("workspace-roots");
    clear(host);
    host.appendChild(SkeletonRow(2));
    var roots = await api.listWorkspaceRoots();
    clear(host);
    loadNavWorkspaces().catch(function () {});
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
     Artifacts view (D35)
     ================================================================== */

  async function loadArtifacts() {
    var host = el("artifacts-list");
    if (!host) return;
    clear(host);
    host.appendChild(SkeletonRow(3));
    var artifacts = [];
    try { artifacts = await api.listArtifacts(); } catch (_e) { artifacts = []; }
    clear(host);
    if (!artifacts || artifacts.length === 0) {
      host.appendChild(EmptyState("No artifacts yet. Upload an image or generate something."));
      return;
    }
    // Newest first.
    var sorted = artifacts.slice().sort(function (a, b) {
      return (b.addedAt || 0) - (a.addedAt || 0);
    });
    sorted.forEach(function (art) {
      var card = h("div", { class: "card card-pad row" }, [
        h("div", { class: "grow stack" }, [
          h("span", { class: "mono grow", text: art.name || art.artifactId }),
          h("span", { class: "faint", text: (art.contentType || "").split("/")[1] + "  ·  " +
            formatBytes(art.size) + "  ·  " + new Date(art.addedAt).toLocaleString() }),
          art.sourceRunId
            ? h("span", { class: "faint", text: "from run: " + art.sourceRunId })
            : null,
        ]),
        Button("Open", {
          small: true,
          onClick: async function () {
            try {
              var payload = await api.getArtifact(art.artifactId);
              if (payload) showArtifactDetail(art, payload);
            } catch (_e) { toast("Could not read artifact.", "danger"); }
          },
        }),
        Button("Download", {
          small: true,
          variant: "info",
          onClick: async function () {
            try {
              var dl = await api.downloadArtifact(art.artifactId);
              if (dl && dl.url) {
                var a = document.createElement("a");
                a.href = dl.url; a.download = art.name || art.artifactId;
                document.body.appendChild(a); a.click(); a.remove();
              }
            } catch (_e) { toast("Download failed.", "danger"); }
          },
        }),
      ]);
      host.appendChild(card);
    });
  }

  function formatBytes(b) {
    if (b == null) return "—";
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    return (b / 1024 / 1024).toFixed(1) + " MB";
  }

  function showArtifactDetail(art, payload) {
    // Images render inline; everything else is text or raw bytes summary.
    var container = h("div", { class: "stack", style: "margin:var(--s3) 0" });
    if (art.contentType && art.contentType.startsWith("image/")) {
      if (payload && payload.src) {
        container.appendChild(h("img", { src: payload.src, style: "max-width:100%;border-radius:var(--radius)" }));
      } else {
        container.appendChild(EmptyState("Image data unavailable."));
      }
    } else {
      container.appendChild(mono(payload ? payload.text || JSON.stringify(payload, null, 2) : "(empty)"));
    }
    openModal(
      art.name || art.artifactId,
      container,
      { confirmLabel: "Close", cancelLabel: null },
    );
  }

  /**
   * D35: download a generated image to the host filesystem. The bytes come
   * from the content-addressed store through the facade — the renderer never
   * sees the base path, only the artifact id it received from a generation
   * result or an upload.
   */
  function downloadArtifact(artifactId) {
    api
      .downloadArtifact(artifactId)
      .then(function (payload) {
        var bytes = payload.bytes;
        if (!(bytes instanceof Uint8Array)) {
          // The IPC layer may hand back a plain array; coerce for the blob.
          bytes = new Uint8Array(Array.from(bytes));
        }
        var blob = new Blob([bytes], { type: "image/png" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = (payload.artifactId || "generated") + ".png";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast("Downloaded " + (payload.artifactId || "image"), "ok");
      })
      .catch(function (e) {
        toast("Download failed: " + (e instanceof Error ? e.message : String(e)), "danger");
      });
  }

  /**
   * P1-6: image generation modal. The human types a prompt; the request
   * crosses the bridge as a plain object. The gate (media.enabled = false in
   * the MVP) blocks it before any credential or transport is touched, so the
   * modal is safe to show even with no provider registered.
   */
  function openGenerateModal() {
    var body = h("div", { class: "stack" }, [
      h("label", { class: "muted", text: "Prompt" }),
      h("textarea", {
        id: "generate-prompt",
        rows: 3,
        placeholder: "Describe the image you want to generate…",
      }),
      h("div", { class: "row" }, [
        h("label", { class: "muted", text: "Capability" }),
        h("select", { id: "generate-capability" }, [
          h("option", { value: "TEXT_TO_IMAGE", text: "Text → Image" }),
          h("option", { value: "IMAGE_TO_IMAGE", text: "Image → Image" }),
          h("option", { value: "IMAGE_EDIT", text: "Image Edit" }),
          h("option", { value: "IMAGE_UPSCALE", text: "Image Upscale" }),
        ]),
      ]),
      h("div", { class: "row" }, [
        h("label", { class: "muted", text: "Resolution" }),
        h("select", { id: "generate-resolution" }, [
          h("option", { value: "", text: "Default" }),
          h("option", { value: "512x512", text: "512×512" }),
          h("option", { value: "1024x1024", text: "1024×1024" }),
          h("option", { value: "1536x1024", text: "1536×1024 (3:2)" }),
          h("option", { value: "1024x1536", text: "1024×1536 (2:3)" }),
          h("option", { value: "1792x1024", text: "1792×1024 (16:9)" }),
          h("option", { value: "1024x1792", text: "1024×1792 (9:16)" }),
        ]),
      ]),
      h("div", { class: "row" }, [
        h("label", { class: "muted", text: "Aspect ratio" }),
        h("select", { id: "generate-aspect" }, [
          h("option", { value: "", text: "Default" }),
          h("option", { value: "1:1", text: "1:1 (square)" }),
          h("option", { value: "16:9", text: "16:9 (widescreen)" }),
          h("option", { value: "9:16", text: "9:16 (portrait)" }),
          h("option", { value: "4:3", text: "4:3 (landscape)" }),
          h("option", { value: "3:4", text: "3:4 (portrait)" }),
          h("option", { value: "3:2", text: "3:2 (landscape)" }),
          h("option", { value: "2:3", text: "2:3 (portrait)" }),
        ]),
      ]),
      h("div", { class: "row" }, [
        h("label", { class: "muted", text: "Seed" }),
        h("input", { id: "generate-seed", type: "number", placeholder: "optional" }),
      ]),
      h("div", { id: "generate-status", class: "muted", text: "" }),
    ]);
    openModal("Generate image", body, {
      confirmLabel: "Generate",
      cancelLabel: "Cancel",
      confirm: function () {
        var prompt = (el("generate-prompt") || {}).value || "";
        var capability = (el("generate-capability") || {}).value || "TEXT_TO_IMAGE";
        var resolution = (el("generate-resolution") || {}).value || "";
        var aspect = (el("generate-aspect") || {}).value || "";
        var seed = (el("generate-seed") || {}).value || "";
        var params = {};
        if (resolution) {
          var parts = resolution.split("x");
          if (parts.length === 2) params.resolution = [Number(parts[0]), Number(parts[1])];
        }
        if (aspect) params.aspectRatio = aspect;
        if (seed) params.seed = Number(seed);
        var statusEl = el("generate-status");
        if (statusEl) text(statusEl, "Generating…");
        var runId = "media-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
        // D35: the cancel button aborts the in-flight call. The desktop stack
        // owns the abort controller; a cancelled attempt is never retried.
        var cancelBtn = h("button", {
          id: "generate-cancel",
          class: "btn",
          text: "Cancel generation",
          disabled: true,
        });
        if (statusEl && statusEl.parentNode) statusEl.parentNode.insertBefore(cancelBtn, statusEl.nextSibling);
        var settled = false;
        var setCancelEnabled = function (enabled) {
          if (cancelBtn) {
            cancelBtn.disabled = !enabled;
            cancelBtn.textContent = enabled ? "Cancel generation" : "Cancelling…";
          }
        };
        // The button is only live while the request is in flight. It starts
        // disabled and is armed once the call is away; every settle path
        // (result, throw, or cancel) removes it so it can never linger.
        setCancelEnabled(true);
        cancelBtn.addEventListener("click", function () {
          if (cancelBtn.disabled) return;
          setCancelEnabled(false);
          api.cancelMedia(runId).then(function () {
            toast("Generation cancelled", "ok");
          });
        });
        api.generateMedia({ capability, prompt, params, runId: runId })
          .then(function (result) {
            settled = true;
            if (cancelBtn) cancelBtn.remove();
            if (statusEl) text(statusEl, "");
            if (!result || !result.ok) {
              // The router returns ok:false with a typed warning for every
              // non-gate failure: no provider, no enabled model, missing key,
              // budget exceeded, generation cap, cost unknown. Surface the
              // warning verbatim — it already says WHAT to fix.
              var warn = result && result.warnings && result.warnings.length > 0
                ? result.warnings.join("; ")
                : "Media generation failed";
              toast(warn, "danger");
              return;
            }
            // Each generated artifact lands in the store; render it inline.
            for (var i = 0; i < result.artifacts.length; i++) {
              var art = result.artifacts[i];
              renderTranscript({
                kind: "generated",
                label: "Generated " + (result.model || "image"),
                body: "",
                contentType: art.mimeType,
                artifactId: art.artifactId,
              });
            }
            var genNote = result.costUnknown
              ? "Image generated (cost not reported by the provider — treated as unknown)."
              : "Image generated.";
            toast(genNote, "ok");
          })
          .catch(function (e) {
            settled = true;
            if (cancelBtn) cancelBtn.remove();
            if (statusEl) text(statusEl, "");
            // The only thing that throws out of the router is the frozen gate.
            // Everything else is returned as a typed warning above, so a throw
            // here is MEDIA_DISABLED — tell the human the switch to flip.
            var msg = e instanceof Error ? e.message : String(e);
            if (/media.enabled = false/i.test(msg)) {
              toast("Media generation is disabled — enable it in Settings (Media generation) before generating.", "danger");
            } else if (/cancelled/i.test(msg)) {
              toast("Generation cancelled", "ok");
            } else {
              toast("Generate failed: " + esc(msg), "danger");
            }
          });
      },
    });
  }

  async function loadSettings() {
    var credHost = el("settings-credentials");
    clear(credHost);
    credHost.appendChild(SkeletonRow(2));

    // Each section is isolated: a failure in one (e.g. the usage totals
    // endpoint) must not leave the rest of the view on a skeleton, and the
    // human must see WHAT failed rather than a blank page.
    try {
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
    } catch (e) {
      clear(credHost);
      credHost.appendChild(ErrorState("Could not load credentials: " + esc(e)));
    }

    var usageHost = el("settings-usage");
    clear(usageHost);
    try {
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
    } catch (e) {
      usageHost.appendChild(ErrorState("Could not load usage totals: " + esc(e)));
    }

    var budgetHost = el("settings-budget");
    clear(budgetHost);
    budgetHost.appendChild(h("h3", { text: "Spend budget" }));
    budgetHost.appendChild(
      h("p", { class: "muted", style: "margin:0 0 var(--s2)", text: "USD the engine may spend on paid models. 0 means no spend — a paid model is selectable but will be refused at the budget gate. Raising this is an explicit act; nothing raises it without you typing a number." }),
    );
    try {
      var budget = await api.getBudget();
      var budgetInput = h("input", {
        id: "settings-budget-input",
        type: "number",
        class: "input",
        min: "0",
        max: "1000000",
        step: "1",
        value: String(budget.budgetUsd),
      });
      var budgetStatus = h("div", { class: "muted mono", style: "margin:var(--s2) 0 0", text: "current: " + budget.budgetUsd + " USD · reserved " + budget.reservedUsd + " · spent " + budget.spentUsd });
      budgetInput.addEventListener("change", async function () {
        var n = Number(budgetInput.value);
        if (!Number.isFinite(n) || n < 0) {
          budgetInput.value = String(budget.budgetUsd);
          budgetStatus.textContent = "invalid value; unchanged";
          return;
        }
        try {
          var saved = await api.patchSettings({ budgetUsd: Math.min(n, 1000000) });
          budgetInput.value = String(saved.budgetUsd);
          budgetStatus.textContent = "budget set to " + saved.budgetUsd + " USD";
        } catch (e) {
          budgetStatus.textContent = "failed to save budget";
        }
      });
      budgetHost.appendChild(budgetInput);
      budgetHost.appendChild(budgetStatus);
    } catch (e) {
      budgetHost.appendChild(ErrorState("Could not load budget: " + esc(e)));
    }

    // D35: media generation opt-in. The frozen default is OFF; flipping this is
    // the explicit human act that permits a media call at all. It does nothing
    // by itself — a provider with media capabilities AND a non-zero budget for
    // paid models are also required — but it is the switch the UI shows.
    var mediaHost = el("settings-media");
    clear(mediaHost);
    mediaHost.appendChild(h("h3", { text: "Media generation" }));
    var mediaEnabled = false;
    try {
      var settings = await api.getSettings();
      mediaEnabled = Boolean(settings && settings.mediaEnabled);
    } catch (e) {
      mediaHost.appendChild(ErrorState("Could not load media setting: " + esc(e)));
    }
    var mediaToggle = h("label", { class: "field" }, [
      h("input", { id: "settings-media-toggle", type: "checkbox", checked: mediaEnabled }),
      h("span", { text: "Enable image generation" }),
    ]);
    var mediaNote = h("p", { class: "muted", style: "margin:0 0 var(--s2)", text: "Off by default. When on, the Generate button appears and a registered provider with media capabilities can produce images. A paid model also needs a non-zero spend budget and an explicit approval." });
    var mediaStatus = h("div", { class: "muted mono", style: "margin:var(--s2) 0 0", text: mediaEnabled ? "media generation is enabled" : "media generation is disabled (frozen default)" });
    var mediaToggleEl = el("settings-media-toggle");
    if (mediaToggleEl) {
      mediaToggleEl.addEventListener("change", async function () {
        var next = mediaToggleEl.checked;
        try {
          var saved = await api.patchSettings({ mediaEnabled: next });
          mediaStatus.textContent = saved.mediaEnabled
            ? "media generation is enabled"
            : "media generation is disabled (frozen default)";
        } catch (e) {
          mediaToggleEl.checked = !next;
          mediaStatus.textContent = "failed to save media setting";
        }
      });
    }
    mediaHost.appendChild(mediaToggle);
    mediaHost.appendChild(mediaNote);
    mediaHost.appendChild(mediaStatus);

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
              h("span", { class: "muted mono", text: p.endpoint + " · " + (p.protocol || "openai-compatible") + " · " + (p.models || []).map(function (m) { return m.id; }).join(", ") }),
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
    var protocolInput = h("select", { id: "pv-protocol", class: "input" }, [
      h("option", { value: "openai-compatible", text: "OpenAI-compatible (POST /chat/completions)" }),
      h("option", { value: "anthropic", text: "Anthropic Messages (POST /messages) — FCC gateway" }),
    ]);
    // D35: media capabilities + declared per-image cost. These are what make a
    // model usable by the media router; without them the provider is registered
    // but can never route a media request.
    var mediaCapsInput = h("input", { id: "pv-mediacaps", type: "text", class: "input", placeholder: "TEXT_TO_IMAGE, IMAGE_TO_IMAGE (leave blank for text-only)" });
    var costInput = h("input", { id: "pv-cost", type: "number", class: "input", placeholder: "cost per image USD, e.g. 0.006 (blank = unknown)" });
    costInput.min = "0";
    costInput.step = "0.001";
    // D35: the image-generation path. OpenRouter mounts it at /images; the
    // OpenAI-compatible default is /images/generations. Leave blank for the
    // default — a typo can never redirect a generation to an unintended path.
    var imagePathInput = h("input", { id: "pv-imagepath", type: "text", class: "input", placeholder: "image path, e.g. /images (blank = /images/generations)" });
    const testOut = h("div", { class: "muted mono", text: "" });
    const refreshOut = h("div", { class: "muted mono", text: "" });
    var discovered = null;
    var answer = await openModal(
      "Add a model provider",
      h("div", { class: "stack" }, [
        h("p", { class: "muted", style: "margin:0", text: "A key travels only as an environment-variable name — the value is read at call time by the engine, never stored here." }),
        h("label", { class: "field" }, [h("span", { text: "Id" }), idInput]),
        h("label", { class: "field" }, [h("span", { text: "Endpoint" }), endpointInput]),
        h("label", { class: "field" }, [h("span", { text: "Protocol" }), protocolInput]),
        h("label", { class: "field" }, [h("span", { text: "Key env var" }), keyInput]),
        h("label", { class: "field" }, [h("span", { text: "Models" }), modelsInput]),
        h("label", { class: "field" }, [h("span", { text: "Media capabilities" }), mediaCapsInput]),
        h("label", { class: "field" }, [h("span", { text: "Cost per image (USD)" }), costInput]),
        h("label", { class: "field" }, [h("span", { text: "Image path" }), imagePathInput]),
        h("p", { class: "muted", style: "margin:0", text: "Media capabilities are the ids the media router matches against (TEXT_TO_IMAGE, IMAGE_TO_IMAGE, IMAGE_EDIT, IMAGE_UPSCALE, INPAINT, OUTPAINT, IMAGE_ANALYSIS, TEXT_TO_VIDEO, …). Without them the model is text-only for media purposes. The cost is what one generation charges; leave it blank when you do not know it — the router will flag the call as cost-unknown rather than treating it as free. The image path is the endpoint-relative path the adapter calls for generation: OpenRouter uses /images, the OpenAI-compatible default is /images/generations. Leave blank for the default." }),
        h("p", { class: "muted", style: "margin:0", text: "Type the model ids you know, or leave them blank and use Refresh models to pull the full catalogue the gateway advertises." }),
        Button("Test config", {
          small: true,
          onClick: async function () {
            testOut.textContent = "testing…";
            try {
              var raw = {
                id: String(idInput.value || "").trim(),
                displayName: String(idInput.value || "").trim(),
                endpoint: String(endpointInput.value || "").trim(),
                protocol: String(protocolInput.value || "openai-compatible"),
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
        Button("Refresh models", {
          small: true,
          onClick: async function () {
            refreshOut.textContent = "refreshing…";
            try {
              var result = await api.discoverModels({
                endpoint: String(endpointInput.value || "").trim(),
                protocol: String(protocolInput.value || "openai-compatible"),
                apiKeyEnv: String(keyInput.value || "").trim() || null,
              });
              if (result.ok) {
                discovered = result.models;
                refreshOut.textContent = `Discovered ${result.count} model(s) from the gateway — they will be registered when you save.`;
              } else {
                discovered = null;
                refreshOut.textContent = `FAILED: ${result.detail}`;
              }
            } catch (e) {
              discovered = null;
              refreshOut.textContent = String(e);
            }
          },
        }),
        testOut,
        refreshOut,
      ]),
      { confirmLabel: "Add" },
    );
    if (!answer) return;
    var id = String(idInput.value || "").trim();
    var endpoint = String(endpointInput.value || "").trim();
    var keyEnv = String(keyInput.value || "").trim();
    var protocol = String(protocolInput.value || "openai-compatible");
    var imagePath = String(imagePathInput.value || "").trim();
    var manualModels = String(modelsInput.value || "")
      .split(",")
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
    // D35: media capabilities are comma-separated capability ids. Unknown ids
    // are dropped at the settings boundary, so a typo can never select an
    // unintended media model.
    var mediaCapsRaw = String(mediaCapsInput.value || "")
      .split(",")
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
    var costRaw = String(costInput.value || "").trim();
    var costVal = costRaw.length > 0 ? Number(costRaw) : null;
    var modelDefs = manualModels.length > 0
      ? manualModels.map(function (m) {
          var def = { id: m, displayName: m };
          if (mediaCapsRaw.length > 0) def.mediaCapabilities = mediaCapsRaw;
          if (costVal !== null && Number.isFinite(costVal) && costVal >= 0) def.costEstimateUsd = costVal;
          return def;
        })
      : (discovered || []).map(function (m) {
          var def = { id: m.id, displayName: m.displayName || m.id, streaming: m.streaming === true };
          if (mediaCapsRaw.length > 0) def.mediaCapabilities = mediaCapsRaw;
          if (costVal !== null && Number.isFinite(costVal) && costVal >= 0) def.costEstimateUsd = costVal;
          return def;
        });
    if (!id || !endpoint || modelDefs.length === 0) {
      toast("A provider needs an id, an endpoint, and at least one model.", "warn");
      return;
    }
    var settings = await api.getSettings();
    var existing = (settings && settings.providers) || [];
    var prov = {
      id: id,
      displayName: id,
      endpoint: endpoint,
      protocol: protocol,
      apiKeyEnv: keyEnv || null,
      models: modelDefs,
    };
    if (imagePath.length > 0) prov.imagePath = imagePath;
    var next = existing.concat([prov]);
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
    var settings = await api.getSettings();
    var providerCount = (settings && settings.providers) || [];
    text(
      el("posture"),
      "egress " + posture.egress + " · budget " + posture.budgetUsd + " USD · policy " +
        posture.policy + " · providers " + providerCount.length + " · runs " +
        status.runs + " · credentials " + (status.credentials || []).length,
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
    chat: function () {
      renderTranscript(state.lastResult);
      syncAgentState();
      renderWelcome();
      populateModelSelect();
    },
    compare: loadCompare,
    collab: loadCollab,
    runs: loadRuns,
    tools: loadTools,
    approvals: loadApprovals,
    audit: loadAudit,
    models: loadModels,
    workspace: loadWorkspace,
    artifacts: loadArtifacts,
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
      // `agent` is not a real view — the single-model chat view is `chat`. Without
      // this fix the polling branch never fires and a pending approval raised
      // during a chat run is not refreshed until the human switches views.
      if (state.view === "approvals" || state.view === "chat") {
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
        var view = ev.currentTarget.getAttribute("data-view");
        if (view) showView(view);
      });
    }

    ["light", "dark", "system"].forEach(function (name) {
      var btn = el("theme-" + name);
      if (btn) btn.addEventListener("click", function () {
        setTheme(name);
      });
    });

    // The chat-head segment is the EXECUTION-type control (Single / Compare /
    // Collaborate), not the safety mode: it only ever exists for view routing.
    // Safety modes live in the Settings → Mode select and the diagnostic view.
    var singleBtn = el("mode-INSPECT");
    if (singleBtn) singleBtn.addEventListener("click", function () { selectExecType("single"); });
    var cmpBtn = el("mode-COMPARE");
    if (cmpBtn) cmpBtn.addEventListener("click", function () { selectExecType("compare"); });
    var collabBtn = el("mode-COLLAB");
    if (collabBtn) collabBtn.addEventListener("click", function () { selectExecType("collab"); });
    var execTypeSel = el("exec-type");
    if (execTypeSel) execTypeSel.addEventListener("change", function () {
      selectExecType(execTypeSel.value);
    });

    el("agent-run").addEventListener("click", runAgent);
    el("agent-cancel").addEventListener("click", cancelAgent);
    var firstLocal = el("first-run-local");
    if (firstLocal) firstLocal.addEventListener("click", function () {
      state.firstRunDismissed = true;
      var card = el("agent-first-run");
      if (card && card.style) card.style.display = "none";
      el("agent-prompt").focus();
    });
    var firstDismiss = el("first-run-dismiss");
    if (firstDismiss) firstDismiss.addEventListener("click", function () {
      state.firstRunDismissed = true;
      var card = el("agent-first-run");
      if (card && card.style) card.style.display = "none";
    });
    var firstProvider = el("first-run-provider");
    if (firstProvider) firstProvider.addEventListener("click", function () {
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
    var promptEl = el("agent-prompt");
    if (promptEl) promptEl.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        runAgent();
      }
    });

    /* Chat history panel (D39): search, new-chat, and conversation switching. */
    var historyNew = el("history-new");
    if (historyNew) historyNew.addEventListener("click", function () {
      state.chatHistoryActive = null;
      renderChatHistory();
      el("agent-prompt") && el("agent-prompt").focus();
    });
    var historySearch = el("history-search");
    if (historySearch) historySearch.addEventListener("input", function () {
      state.chatHistorySearch = historySearch.value;
      renderChatHistory();
    });
    renderChatHistory();

    // D35: attach a file from the OS dialog; the browser reads it, sends bytes
    // to the facade, then routes through analyzeFile so images go to vision
    // and text goes to the text analyzer. The result appears as a turn in the
    // transcript so the human can see what was extracted.
    var uploadBtn = el("composer-upload");
    var fileInput = el("composer-file-input");
    if (uploadBtn && fileInput) {
      uploadBtn.addEventListener("click", function () { fileInput.click(); });
      fileInput.addEventListener("change", async function () {
        var file = fileInput.files && fileInput.files[0];
        if (!file) return;
        try {
          toast("Reading file: " + file.name, "info");
          // The renderer reads the bytes locally and sends them through
          // uploadBytes. The bytes cross the bridge as a plain array — never
          // a path — and the store confines the write to paths.artifacts.
          var buf = await file.arrayBuffer();
          var bytes = Array.from(new Uint8Array(buf));
          var result = await api.uploadBytes(bytes, file.name);
          if (!result || !result.artifactId) {
            toast("Upload failed.", "danger");
            fileInput.value = "";
            return;
          }
          toast("File uploaded — analyzing...", "info");
          var analysis = await api.analyzeFile(result.artifactId);
          fileInput.value = "";
          var body = analysis ? JSON.stringify(analysis, null, 2) : "(no result)";
          renderTranscript({
            kind: "uploaded",
            label: "Uploaded: " + file.name,
            body: body,
            contentType: file.type,
            artifactId: result.artifactId,
          });
        } catch (e) {
          toast("Upload/analyze failed: " + esc(e), "danger");
          fileInput.value = "";
        }
      });
    }

    /* P1-6: image generation. The button opens a modal where the human types a
     * prompt; the request crosses the bridge as a plain object, and the gate
     * (media.enabled = false in the MVP) blocks it before any credential or
     * transport is touched. When the gate is flipped and a provider is
     * registered, the same channel generates images. */
    var generateBtn = el("composer-generate");
    if (generateBtn) {
      generateBtn.addEventListener("click", function () {
        openGenerateModal();
      });
    }

    /* D39: composer tool affordances — tools toggle and voice input stub. */
    var toolsToggle = el("composer-tools-toggle");
    if (toolsToggle) toolsToggle.addEventListener("click", function () {
      toast("Tools panel coming soon.", "info");
    });
    var micBtn = el("composer-mic");
    if (micBtn) micBtn.addEventListener("click", function () {
      toast("Voice input is not available in this build.", "warn");
    });

    /* Model picker: live search, optional cost filter, and a refresh affordance. */
    var modelSearch = el("model-search");
    if (modelSearch) modelSearch.addEventListener("input", function () {
      state.modelSearch = modelSearch.value;
      // The combobox owns the render path; wire() must not reach for a
      // function that does not exist (a ReferenceError on every keystroke).
      if (modelSelector) modelSelector.setSearch(state.modelSearch);
    });
    var costFilter = el("model-cost-filter");
    if (costFilter) costFilter.addEventListener("click", function (ev) {
      var btn = ev.target;
      if (!btn || !btn.hasAttribute("data-cost")) return;
      state.modelCostFilter = btn.getAttribute("data-cost");
      var btns = costFilter.querySelectorAll("button");
      for (var i = 0; i < btns.length; i++) {
        btns[i].setAttribute("aria-pressed", btns[i].getAttribute("data-cost") === state.modelCostFilter ? "true" : "false");
      }
      if (modelSelector) modelSelector.setCostFilter(state.modelCostFilter);
    });
    var modelRefresh = el("model-refresh");
    if (modelRefresh) modelRefresh.addEventListener("click", function () {
      modelRefresh.disabled = true;
      refreshModelCatalog().then(function () {
        toast("Models & provider status refreshed.", "ok");
      }).catch(function () {
        toast("Could not refresh the model list.", "warn");
      }).then(function () {
        modelRefresh.disabled = false;
      });
    });

    el("compare-start").addEventListener("click", function () {
      startCompare();
    });
    el("collab-start").addEventListener("click", function () {
      startCollab();
    });
    el("collab-add-participant")?.addEventListener("click", function () {
      addCollabParticipant();
    });
    el("collab-refresh-recent")?.addEventListener("click", function () {
      loadRecentCollabs().catch(function () {});
    });

    el("workspace-add").addEventListener("click", function () {
      addRoot().catch(function (e) {
        toast("Could not add a folder: " + esc(e), "danger");
      });
    });

    var artifactsRefresh = el("artifacts-refresh");
    if (artifactsRefresh) artifactsRefresh.addEventListener("click", function () {
      loadArtifacts().catch(function () {});
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
        if (state.view === "tools") loadTools().catch(function () {});
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

    /* Language switching (M1): toggle data-en/data-fa and RTL direction. */
    var langSelect = el("lang-select");
    if (langSelect) {
      langSelect.addEventListener("change", function () {
        setLanguage(langSelect.value);
      });
    }
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
    // The composer picker and the sidebar sub-lists must be live from first
    // paint: the views' loaders only run on navigation, so a first session
    // would otherwise start with an empty model select and empty sidebar.
    populateModelSelect().catch(function () {});
    loadNavWorkspaces().catch(function () {});
    loadNavConversations().catch(function () {});
    await refreshStatus();
    await loadApprovals();
    await loadTools();
    startPolling();
    updateFirstRunCard();
    // Language: default to English; a stored preference would go through
    // patchSettings in a future iteration. For now the selector is the control.
    // Re-render the active view when the language changes so text that is
    // built at mount time (rather than carried on a data-en attribute) flips
    // along with the static labels.
    window.addEventListener("all-in-1:languagechange", function () {
      refreshView(state.view).catch(function () {});
    });
    setLanguage("en");
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