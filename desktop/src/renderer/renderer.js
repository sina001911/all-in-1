/**
 * Renderer (D1).
 *
 * Runs in a sandboxed page with NO Node access. Its only capability is the
 * `window.allInOne` object the preload exposes — an enumerated API. There is no
 * filesystem, no process, no engine import, and no way to read a credential
 * value back.
 */
const api = window.allInOne;

function esc(v: unknown): string {
  return String(v).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function refreshStatus(): Promise<void> {
  const status = await api.getSystemStatus();
  document.getElementById("status").textContent =
    `egress: ${status.egress.kind} · budget: ${JSON.stringify(status.budget)} · ` +
    `approvals: ${status.approvals} · runs: ${status.runs}`;
}

async function refreshAll(): Promise<void> {
  await refreshStatus();
  document.getElementById("frozen").textContent = JSON.stringify(
    await api.getFrozenDefaults(),
    null,
    2,
  );
  document.getElementById("approvals").textContent = JSON.stringify(
    await api.listApprovals(),
    null,
    2,
  );
  document.getElementById("usage").textContent = JSON.stringify(
    await api.getUsageTotals(),
    null,
    2,
  );
  document.getElementById("credentials").textContent = JSON.stringify(
    await api.listCredentialNames(),
    null,
    2,
  );
  const logs = await api.listLogs();
  document.getElementById("logs").textContent = logs
    .slice(-40)
    .map((l) => `${new Date(l.ts).toISOString()} [${l.level}] ${l.msg}`)
    .join("\n");
}

let currentRunId = null;

document.getElementById("run").addEventListener("click", async () => {
  const mode = document.getElementById("mode").value;
  const subject = document.getElementById("subject").value;
  const auto = document.getElementById("auto").checked;
  const out = document.getElementById("output");
  const cancelBtn = document.getElementById("cancel");
  out.textContent = "running…";
  cancelBtn.disabled = false;
  try {
    const result = await api.runDiagnostic({ mode, subject, auto });
    currentRunId = result.runId;
    out.textContent = esc(result.text);
  } catch (e) {
    out.textContent = `failed: ${esc(e)}`;
  } finally {
    cancelBtn.disabled = true;
    await refreshAll();
  }
});

document.getElementById("cancel").addEventListener("click", async () => {
  if (!currentRunId) return;
  await api.cancelRun(currentRunId);
  await refreshAll();
});

refreshAll().catch((e) => {
  document.getElementById("status").textContent = `init failed: ${esc(e)}`;
});
