/**
 * State (B1).
 *
 * The single mutable view model for the renderer. Loaded as a classic script
 * FIRST so every later module can read `state` and `api`.
 */
"use strict";

var api = window.allInOne;

var state = {
  theme: "system",
  settings: null,
  view: "chat",
  mode: "INSPECT",
  // Kept ONLY while the last run is paused for the human (the D26 resume
  // flow). Every other time it is "" and the next run gets a fresh id.
  runId: "",
  activeRunId: "", // the run in flight right now, live or not
  busy: false,
  lastResult: null,
  lastRequestedModel: null, // the provider/model the human picked for it
  selectedRunId: null,
  runs: [],
  pending: [],
  firstRunDismissed: false,
  lang: "en",
  liveStream: null,
  modelCatalog: [],
  modelSearch: "",
  modelCostFilter: "all",
  chatHistory: [],
  chatHistoryActive: null,
  chatHistorySearch: "",
};

var MODES = ["INSPECT", "SUGGEST", "BUILD"];

var MODE_HELP = {
  INSPECT: "Read-only analysis. The model is never even shown a write, execute or network tool.",
  SUGGEST: "Analysis and planning. No privileged tool is offered.",
  BUILD: "Privileged tools are offered — files.write, files.edit, process.exec. Every one waits for your approval here.",
};