#!/usr/bin/env node
/* mini-asana render-grouping regression (13 assertions, no browser needed).
 *
 * Rule under test: a subtask nests under its parent only when both live in the
 * SAME section (a completed subtask can be archived on its own while the parent
 * stays active); a parented task whose parent is elsewhere renders as a
 * top-level row of its own section.
 *
 * Method: extract the REAL helper source (parentTask/isChildIn/effectiveTop/
 * childrenIn/hasChildrenIn/flatSectionList + friends) out of ../static/app.js,
 * eval it against bug-scenario data seeded into a throwaway project, and
 * simulate the row sets of the timeline / list / board views.
 *
 * The script is self-contained: it creates its own project via the API,
 * seeds "parent in To do + 2 active children + 2 archived children",
 * and deletes the project again at the end.
 *
 * Usage:  node test_render_grouping.js <port> <token>
 * Easiest: tests/run_local.sh spins up a throwaway instance and runs everything.
 */
const fs = require("fs");
const path = require("path");
const http = require("http");

const [,, port, token] = process.argv;
if (!port || !token) { console.error("usage: node test_render_grouping.js <port> <token>"); process.exit(2); }
const APP_JS = process.env.APP_JS || path.join(__dirname, "..", "static", "app.js");
const src = fs.readFileSync(APP_JS, "utf8");

function grab(re, name) {
  const m = src.match(re);
  if (!m) { console.error("EXTRACT FAIL:", name); process.exit(2); }
  return m[0];
}
// the real function source: single-line helpers + the multi-line display-grouping block
const code = [
  grab(/function taskById\(id\) \{[^\n]*\}/, "taskById"),
  grab(/function childrenOf\(pid\) \{[^\n]*\}/, "childrenOf"),
  grab(/function topTasks\(sec\) \{[^\n]*\}/, "topTasks"),
  grab(/function sectionTasks\(sec\) \{[\s\S]*?\n\}/, "sectionTasks"),
  grab(/function parentTask\(t\) [\s\S]*?return out;\n\}/, "display-grouping block"),
].join("\n");

function call(method, p, body) {
  return new Promise((res, rej) => {
    // NOTE: an explicit Content-Length is required — the stdlib server does not decode
    // chunked transfer encoding and would read an empty body (400) + mangle the rest
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    if (data) headers["Content-Length"] = data.length;
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers }, resp => {
      let d = "";
      resp.on("data", c => d += c);
      resp.on("end", () => res({ status: resp.statusCode, json: d ? JSON.parse(d) : {} }));
    });
    r.on("error", rej);
    if (data) r.write(data);
    r.end();
  });
}

let fails = 0;
const check = (name, cond, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name} ${detail}`);
};

(async () => {
  // ---- setup: throwaway project with the bug-scenario shape ----
  const proj = await call("POST", "/api/projects", { name: "grouping-test-tmp" });
  const pid = proj.json.id;
  const B = `/api/projects/${pid}`;
  try {
    const parent = (await call("POST", `${B}/tasks`, { name: "父任务P", start_on: "2026-09-14", due_on: "2026-10-05" })).json;
    const kids = [];
    for (const n of ["归档子1", "归档子2", "活跃子1", "活跃子2"]) {
      kids.push((await call("POST", `${B}/tasks`, { name: n, parent_id: parent.id, start_on: "2026-09-15", due_on: "2026-09-25" })).json);
    }
    for (const k of kids.slice(0, 2)) await call("PUT", `${B}/tasks/${k.id}`, { completed: true });
    await call("POST", `${B}/archive_completed`);

    const db = (await call("GET", `${B}/tasks`)).json;
    const state = { tasks: db.tasks, sections: db.sections };
    eval(code); // defines the helpers from app.js

    const names = list => list.map(t => t.name).join(", ");
    const ARCHIVED = ["归档子1", "归档子2"], ACTIVE_SUB = ["活跃子1", "活跃子2"];

    // ---- list view: flatSectionList drives render + resequence ----
    const todoFlat = flatSectionList("To do"), archFlat = flatSectionList("Archive");
    check("list: To do 不含归档子任务", !todoFlat.some(t => ARCHIVED.includes(t.name)), names(todoFlat));
    check("list: To do 含父任务+活跃子任务", ACTIVE_SUB.every(n => todoFlat.some(t => t.name === n)) && todoFlat.some(t => t.name === "父任务P"));
    check("list: Archive 含归档子任务(作为 effective-top)", ARCHIVED.every(n => archFlat.some(t => t.name === n)), names(archFlat));
    check("list: 归档子任务在 Archive 无缩进", ARCHIVED.every(n => { const t = archFlat.find(x => x.name === n); return t && !isChildIn(t, "Archive"); }));

    // ---- timeline: secTasks filter + expanded rows (all tasks dated -> all have bars) ----
    const bars = new Map(state.tasks.map(t => [t.id, {}]));
    const tlRows = {};
    for (const sec of state.sections) {
      const secTasks = sectionTasks(sec).filter(t => bars.has(t.id) && (!isChildIn(t, sec) || !bars.has(t.parent_id)));
      const rows = [];
      for (const t of secTasks) {
        rows.push({ t, isSub: false });
        if (!isChildIn(t, sec)) for (const c of childrenIn(t.id, sec).filter(x => bars.has(x.id))) rows.push({ t: c, isSub: true });
      }
      tlRows[sec] = rows;
    }
    const tlTodo = tlRows["To do"], tlArch = tlRows["Archive"];
    check("timeline: To do 不含归档子任务", !tlTodo.some(r => ARCHIVED.includes(r.t.name)), names(tlTodo.map(r => r.t)));
    check("timeline: 父任务下只有同 section 子任务", tlTodo.filter(r => r.isSub).every(r => ACTIVE_SUB.includes(r.t.name)), names(tlTodo.filter(r => r.isSub).map(r => r.t)));
    check("timeline: Archive lane 含归档子任务", ARCHIVED.every(n => tlArch.some(r => r.t.name === n)), names(tlArch.map(r => r.t)));
    check("timeline: 归档子任务在 Archive 为顶层行", tlArch.filter(r => ARCHIVED.includes(r.t.name)).every(r => !r.isSub));

    // ---- board: flat sectionTasks (was already correct) ----
    check("board: Archive 列含归档子任务", ARCHIVED.every(n => sectionTasks("Archive").some(t => t.name === n)));
    check("board: To do 列不含归档子任务", !sectionTasks("To do").some(t => ARCHIVED.includes(t.name)));

    // ---- toggles / progress badge ----
    check("toggle: 父任务在 To do 显示折叠钮(有同区子任务)", hasChildrenIn(parent.id, "To do"));
    check("badge: childrenOf 仍含全部子任务(进度计数不变)", childrenOf(parent.id).length === 4);

    // ---- regression: on same-section data the new grouping degenerates to the old one ----
    state.tasks = db.tasks.map(t => ({ ...t, section: t.parent_id ? "To do" : t.section }));
    const newFlat = flatSectionList("To do");
    const oldFlat = [];
    for (const t of topTasks("To do")) { oldFlat.push(t); oldFlat.push(...childrenOf(t.id)); }
    check("regression: 同区父子数据 flatSectionList 与旧实现一致",
      JSON.stringify(newFlat.map(t => t.id)) === JSON.stringify(oldFlat.map(t => t.id)));
  } finally {
    // ---- teardown ----
    await call("DELETE", `/api/projects/${pid}`);
    console.log("     (temp project cleaned up)");
  }

  console.log();
  if (fails) { console.log(fails + " FAILED"); process.exit(1); }
  console.log("ALL PASS");
})();
