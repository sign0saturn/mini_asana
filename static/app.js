/* mini-asana frontend SPA — vanilla JS, no external dependencies */
"use strict";

/* ================= state ================= */
const state = {
  tasks: [],
  sections: [],
  view: "list",
  calYear: null,
  calMonth: null, // 0-based
  detailId: null,
  tlSelected: new Set(), // timeline multi-selected bars (Shift/Cmd/Ctrl+click), for batch shifting
  projectId: null,       // current project id
  projects: [],          // all projects [{id,name,task_count}]
  legacy: false,         // fall back to single-project mode when the server has no projects API (legacy)
};

/* ================= utilities ================= */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function pad2(n) { return String(n).padStart(2, "0"); }
function fmtDate(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
function parseDate(s) {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function diffDays(a, b) { return Math.round((b - a) / 86400000); }
function today() { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); }

const CAT_PALETTE = ["#4d7dd1", "#5da283", "#9b6dd6", "#e06a5a", "#e8a33d", "#3aa6b9", "#d1689a", "#7d8c4e", "#8a7fe8", "#c9813f", "#5b8c5a", "#b0578d", "#6b7a8f"];
function catColor(name) {
  if (!name) return "#b0b1b2";
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return CAT_PALETTE[h % CAT_PALETTE.length];
}
/* blend #rrggbb toward white by f (0=original color, 1=white): light tint for completed bars */
function tintHex(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const m = c => Math.round(c + (255 - c) * f);
  const r = m(n >> 16), g = m((n >> 8) & 255), b = m(n & 255);
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}
function catPill(cat) {
  if (!cat) return '<span class="pill-empty muted">—</span>';
  return `<span class="pill" style="background:${catColor(cat)}">${esc(cat)}</span>`;
}
function priHtml(p) {
  if (!p) return '<span class="pill-empty muted">—</span>';
  return `<span class="pri-${esc(p)}">${esc(p)}</span>`;
}

function taskById(id) { return state.tasks.find(t => t.id === id); }
function sectionTasks(sec) {
  return state.tasks.filter(t => t.section === sec).sort((a, b) => a.order - b.order);
}

/* ---- subtask helpers (one level only): a task with parent_id renders under its parent, never top-level ---- */
function childrenOf(pid) { return state.tasks.filter(t => t.parent_id === pid).sort((a, b) => a.order - b.order); }
function hasChildren(id) { return state.tasks.some(t => t.parent_id === id); }
function topTasks(sec) { return state.tasks.filter(t => t.section === sec && !t.parent_id).sort((a, b) => a.order - b.order); }
/* flat display sequence of a section: each top-level task followed by its subtasks */
function flatSectionList(sec) {
  const out = [];
  for (const t of topTasks(sec)) { out.push(t); out.push(...childrenOf(t.id)); }
  return out;
}

/* collapsed parent ids, persisted per project ("<projectId>:<taskId>") */
const COLLAPSE_KEY = "mini_asana_collapsed";
function collapsedSet() {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]")); } catch (_) { return new Set(); }
}
function isCollapsed(pid) { return collapsedSet().has(state.projectId + ":" + pid); }
function setCollapsed(pid, on) {
  const s = collapsedSet(), k = state.projectId + ":" + pid;
  if (on) s.add(k); else s.delete(k);
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...s])); } catch (_) {}
}

/* ================= i18n ================= */
/* UI chrome strings in zh/en. Task DATA (task names, section names, Category/Effort/Priority
   values such as 高/中/低) is user content and is never translated — only chrome goes through tr(). */
const I18N = {
  zh: {
    "nav.myTasks": "🏠 我的任务",
    "sidebar.projects": "项目",
    "menu.open": "菜单",
    "menu.close": "关闭菜单",
    "btn.logout": "退出登录",
    "btn.logoutTitle": "清除本地 token 并退出",
    "tab.list": "列表",
    "tab.board": "看板",
    "tab.timeline": "时间线",
    "tab.calendar": "日历",
    "btn.newSection": "＋ 分组",
    "section.addTitle": "新增分组",
    "section.namePh": "新分组名称",
    "section.rename": "重命名分组",
    "section.delete": "删除分组",
    "column.rename": "重命名列",
    "column.delete": "删除列",
    "btn.newProject": "＋ 新建项目",
    "project.addTitle": "新建项目",
    "project.namePh": "新项目名称",
    "project.rename": "重命名项目",
    "project.delete": "删除项目",
    "detail.title": "任务详情",
    "login.tip": "Home improvement tracker · 请输入访问 token",
    "login.tokenPh": "访问 token",
    "login.enter": "进入",
    "login.badToken": "token 不正确，请重试",
    "app.loadFailed": "加载失败: {msg}",
    "btn.cancel": "取消",
    "btn.ok": "确认",
    "btn.close": "关闭",
    "btn.create": "创建",
    "dlg.newTask": "新建任务",
    "field.name": "任务名称",
    "field.namePh": "要做什么？",
    "field.section": "分组",
    "field.assignee": "负责人",
    "field.start": "开始日期",
    "field.due": "截止日期",
    "field.effort": "工作量",
    "field.deps": "前置依赖",
    "field.notes": "备注",
    "deps.entry": "{name}（{section}）",
    "select.none": "无",
    "select.custom": "自定义…",
    "select.customPrompt": "输入新值，回车确认",
    "select.customValue": "输入新值",
    "task.add": "＋ 添加任务",
    "task.delete": "删除任务",
    "task.markDone": "标记为完成",
    "task.markUndone": "标记为未完成",
    "task.dragHandle": "拖拽排序 / 移动分组",
    "task.openDetail": "点击打开详情",
    "task.openInAsana": "在 Asana 中打开 ↗",
    "cell.clickEdit": "点击编辑",
    "stats.openShort": "未完成",
    "stats.openLong": "个未完成任务 · {done} 已完成",
    "tl.corner": "任务 / 日期",
    "tl.empty": "没有带日期的任务。在任务详情中设置开始/截止日期后会显示在这里。",
    "tl.dueOnly": "截止 {date}",
    "tl.skipped": "（{n} 个没有日期的任务未在时间线中显示）",
    "cal.prev": "← 上月",
    "cal.today": "今天",
    "cal.next": "下月 →",
    "cal.more": "+{n} 更多",
    "confirm.deleteTask": "删除任务「{name}」？",
    "confirm.deleteSection": "删除分组「{name}」？其中的任务会移到第一个分组。",
    "confirm.deleteProject": "删除项目「{name}」？其中的任务会一并删除，不可恢复。",
    "toast.createFailed": "创建失败: {msg}",
    "toast.saveFailed": "保存失败: {msg}",
    "toast.moveFailed": "移动失败: {msg}",
    "toast.deleteFailed": "删除失败: {msg}",
    "toast.renameFailed": "重命名失败: {msg}",
    "toast.deleteSectionFailed": "删除分组失败: {msg}",
    "toast.deleteProjectFailed": "删除项目失败: {msg}",
    "toast.loadProjectFailed": "加载项目失败: {msg}",
    "field.parent": "父任务",
    "field.parentLocked": "已有子任务的任务不能再设为子任务",
    "task.addSubtask": "＋ 添加子任务",
    "task.subtaskOf": "「{name}」的子任务",
    "sub.collapse": "收起子任务",
    "sub.expand": "展开子任务",
    "sub.progress": "子任务进度 {done}/{total}",
    "sub.unparent": "移出父任务",
    "toast.parentHasChildren": "该任务已有子任务，不能再设为子任务",
  },
  en: {
    "nav.myTasks": "🏠 My tasks",
    "sidebar.projects": "Projects",
    "menu.open": "Menu",
    "menu.close": "Close menu",
    "btn.logout": "Log out",
    "btn.logoutTitle": "Clear the local token and log out",
    "tab.list": "List",
    "tab.board": "Board",
    "tab.timeline": "Timeline",
    "tab.calendar": "Calendar",
    "btn.newSection": "＋ Section",
    "section.addTitle": "Add section",
    "section.namePh": "New section name",
    "section.rename": "Rename section",
    "section.delete": "Delete section",
    "column.rename": "Rename column",
    "column.delete": "Delete column",
    "btn.newProject": "＋ New project",
    "project.addTitle": "New project",
    "project.namePh": "New project name",
    "project.rename": "Rename project",
    "project.delete": "Delete project",
    "detail.title": "Task details",
    "login.tip": "Home improvement tracker · Enter access token",
    "login.tokenPh": "Access token",
    "login.enter": "Enter",
    "login.badToken": "Incorrect token, please try again",
    "app.loadFailed": "Failed to load: {msg}",
    "btn.cancel": "Cancel",
    "btn.ok": "OK",
    "btn.close": "Close",
    "btn.create": "Create",
    "dlg.newTask": "New task",
    "field.name": "Task name",
    "field.namePh": "What needs to be done?",
    "field.section": "Section",
    "field.assignee": "Assignee",
    "field.start": "Start date",
    "field.due": "Due date",
    "field.effort": "Effort",
    "field.deps": "Dependencies",
    "field.notes": "Notes",
    "deps.entry": "{name} ({section})",
    "select.none": "None",
    "select.custom": "Custom…",
    "select.customPrompt": "Type a new value, Enter to confirm",
    "select.customValue": "Type a new value",
    "task.add": "＋ Add task",
    "task.delete": "Delete task",
    "task.markDone": "Mark as done",
    "task.markUndone": "Mark as not done",
    "task.dragHandle": "Drag to reorder / move section",
    "task.openDetail": "Click to open details",
    "task.openInAsana": "Open in Asana ↗",
    "cell.clickEdit": "Click to edit",
    "stats.openShort": "open",
    "stats.openLong": "open tasks · {done} done",
    "tl.corner": "Tasks / Dates",
    "tl.empty": "No dated tasks. Set start/due dates in the task details and they will show up here.",
    "tl.dueOnly": "Due {date}",
    "tl.skipped": "({n} tasks without dates are not shown on the timeline)",
    "cal.prev": "← Prev",
    "cal.today": "Today",
    "cal.next": "Next →",
    "cal.more": "+{n} more",
    "confirm.deleteTask": "Delete task \"{name}\"?",
    "confirm.deleteSection": "Delete section \"{name}\"? Its tasks will be moved to the first section.",
    "confirm.deleteProject": "Delete project \"{name}\"? All its tasks will be permanently deleted.",
    "toast.createFailed": "Create failed: {msg}",
    "toast.saveFailed": "Save failed: {msg}",
    "toast.moveFailed": "Move failed: {msg}",
    "toast.deleteFailed": "Delete failed: {msg}",
    "toast.renameFailed": "Rename failed: {msg}",
    "toast.deleteSectionFailed": "Failed to delete section: {msg}",
    "toast.deleteProjectFailed": "Failed to delete project: {msg}",
    "toast.loadProjectFailed": "Failed to load project: {msg}",
    "field.parent": "Parent task",
    "field.parentLocked": "Tasks with subtasks can't become a subtask",
    "task.addSubtask": "＋ Add subtask",
    "task.subtaskOf": "Subtask of {name}",
    "sub.collapse": "Collapse subtasks",
    "sub.expand": "Expand subtasks",
    "sub.progress": "Subtask progress {done}/{total}",
    "sub.unparent": "Remove from parent",
    "toast.parentHasChildren": "This task already has subtasks and can't become one",
  },
};

const LANG_KEY = "mini_asana_lang";
function detectLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch (_) {}
  return /^zh/i.test(navigator.language || "") ? "zh" : "en";
}
let lang = detectLang();

function locale() { return lang === "zh" ? "zh-CN" : "en-US"; }

/* dictionary lookup with {var} interpolation (named tr: `t` is used as a task variable in many loops) */
function tr(key, vars) {
  const dict = I18N[lang] || I18N.zh;
  let s = dict[key] != null ? dict[key] : I18N.zh[key];
  if (s == null) return key;
  if (vars) for (const k of Object.keys(vars)) s = s.split("{" + k + "}").join(String(vars[k]));
  return s;
}

/* locale month label: zh "2026年7月" / en "July 2026" (m0 is 0-based) */
function monthLabel(y, m0) {
  return new Date(y, m0, 1).toLocaleString(locale(), { year: "numeric", month: "long" });
}
/* locale weekday labels Mon..Sun: zh 周一..周日 / en Mon..Sun (2024-01-01 was a Monday) */
function weekdayLabels() {
  return Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(locale(), { weekday: "short" }));
}

/* translate static HTML via data-i18n / data-i18n-title / data-i18n-placeholder, and set <html lang> */
function applyI18n() {
  $$("[data-i18n]").forEach(el => { el.textContent = tr(el.dataset.i18n); });
  $$("[data-i18n-title]").forEach(el => { el.title = tr(el.dataset.i18nTitle); });
  $$("[data-i18n-placeholder]").forEach(el => { el.placeholder = tr(el.dataset.i18nPlaceholder); });
  /* dynamically created elements (inline creators) tagged with i18n keys */
  $$("[data-i18n-dynamic]").forEach(el => { el.textContent = tr(el.dataset.i18nDynamic); });
  $$("[data-i18n-dynamic-ph]").forEach(el => { el.placeholder = tr(el.dataset.i18nDynamicPh); });
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
}

function updateLangSwitch() {
  $$("#lang-switch button").forEach(b => b.classList.toggle("active", b.dataset.lang === lang));
}

function setLang(l) {
  if (l !== "zh" && l !== "en") return;
  lang = l;
  try { localStorage.setItem(LANG_KEY, l); } catch (_) {}
  applyI18n();
  updateLangSwitch();
  render(); // re-render all dynamic content in the new language
}


/* ================= touch dragging (Pointer Events, works on iOS Safari) ================= */
/* Desktop still uses HTML5 DnD; this module only engages when pointerType === "touch".
   Two-condition trigger model to avoid misfires:
     phase 0 (waiting):  pressDelay long-press timer; movement > cancelThreshold(15px) during
                         the wait counts as scroll/swipe and cancels.
     phase 1 (armed):    long-press succeeded -> vibration + highlight outline, no ghost yet.
     phase 2 (dragging): movement > dragThreshold(10px) after armed starts the real drag
                         (following ghost + non-passive touchmove preventDefault scroll lock).
   A plain tap (no long-press, small movement) triggers no drag visuals; click passes through. */
let dragTaskId = null; // task currently being dragged in the list view (gates the make-subtask drop zone)
let suppressClickUntil = 0; // briefly suppress click after a drag ends, to avoid opening details by accident
function clickSuppressed() { return Date.now() < suppressClickUntil; }

function _lockScroll(e) { e.preventDefault(); }

function attachTouchDrag(el, opts) {
  const pressDelay = opts.pressDelay != null ? opts.pressDelay : 400;
  const cancelTh = opts.cancelThreshold || 15; // how much movement during the wait phase counts as scroll-cancel
  const dragTh = opts.dragThreshold || 10;     // how much movement after armed starts the real drag
  el.addEventListener("pointerdown", e => {
    if (e.pointerType !== "touch" || e.button > 0) return;
    const startX = e.clientX, startY = e.clientY;
    let phase = 0, ghost = null; // 0=waiting for long-press 1=armed 2=dragging
    try { el.setPointerCapture(e.pointerId); } catch (_) {} // tracking only; does not affect scrolling
    const timer = setTimeout(arm, pressDelay);

    function arm() {
      if (phase !== 0) return;
      phase = 1;
      el.classList.add("touch-armed");
      suppressClickUntil = Date.now() + 500;
      if (navigator.vibrate) try { navigator.vibrate(10); } catch (_) {}
    }
    function startDrag() {
      phase = 2;
      ghost = opts.makeGhost ? opts.makeGhost() : null;
      if (ghost) {
        ghost.classList.add("touch-ghost");
        document.body.appendChild(ghost);
        ghost.style.left = (startX + 10) + "px";
        ghost.style.top = (startY - 24) + "px";
      }
      el.classList.add("touch-dragging");
      document.addEventListener("touchmove", _lockScroll, { passive: false });
    }
    function onMove(ev) {
      const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
      if (phase === 0) {
        if (dist > cancelTh) { clearTimeout(timer); cleanup(); } // fast swipe = scroll/tap
        return;
      }
      if (phase === 1) {
        if (dist > dragTh) startDrag();
        return;
      }
      if (ghost) { ghost.style.left = (ev.clientX + 10) + "px"; ghost.style.top = (ev.clientY - 24) + "px"; }
      opts.onMove && opts.onMove(ev.clientX, ev.clientY);
    }
    function onUp(ev) {
      if (phase === 2 && opts.onDrop) opts.onDrop(ev.clientX, ev.clientY);
      if (phase >= 1) suppressClickUntil = Date.now() + 350;
      cleanup();
    }
    function onCancel() { cleanup(); } // fired when the browser takes over scrolling
    function cleanup() {
      clearTimeout(timer);
      document.removeEventListener("touchmove", _lockScroll);
      el.classList.remove("touch-armed", "touch-dragging");
      if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
      if (phase === 2 && opts.onEnd) opts.onEnd();
      phase = 0;
    }
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
  });
}

/* ================= shared UI components (replacing native prompt/confirm/alert) ================= */
/* toast notification (replaces alert) */
function showToast(msg, isError) {
  let t = $("#toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.toggle("toast-error", !!isError);
  t.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove("show"), 3200);
}

/* inline confirm dialog (replaces confirm): message + cancel/ok buttons */
function confirmDialog(message, onOk) {
  const ov = document.createElement("div");
  ov.className = "confirm-overlay";
  ov.innerHTML = `<div class="confirm-card">
    <p class="confirm-msg">${esc(message)}</p>
    <div class="confirm-btns">
      <button type="button" class="btn-cancel">${tr("btn.cancel")}</button>
      <button type="button" class="btn-danger btn-ok">${tr("btn.ok")}</button>
    </div></div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector(".btn-cancel").addEventListener("click", close);
  ov.addEventListener("click", e => { if (e.target === ov) close(); });
  ov.querySelector(".btn-ok").addEventListener("click", () => { close(); onOk(); });
  ov.querySelector(".btn-ok").focus();
}

/*
 * Inline creator (replaces prompt): a "+" button -> click turns it into "input + ✓ confirm".
 * - Enter / clicking ✓ submits (equivalent); Esc cancels and restores the button
 * - blur: restores the button only when empty; non-empty input stays (mobile users may have just dismissed the keyboard)
 * - input and button are disabled while submitting to prevent duplicates; on failure a toast is shown and editing resumes
 */
function makeInlineCreator(opts) {
  const wrap = document.createElement("div");
  wrap.className = "inline-creator";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "add-task-btn" + (opts.buttonClass ? " " + opts.buttonClass : "");
  btn.textContent = opts.buttonLabelKey ? tr(opts.buttonLabelKey) : opts.buttonLabel;
  if (opts.buttonLabelKey) btn.dataset.i18nDynamic = opts.buttonLabelKey; // applyI18n refreshes tagged buttons
  wrap.appendChild(btn);

  btn.addEventListener("click", () => {
    const form = document.createElement("div");
    form.className = "inline-creator-form";
    const inp = document.createElement("input");
    inp.className = "inline-input";
    inp.placeholder = opts.placeholderKey ? tr(opts.placeholderKey) : (opts.placeholder || "");
    if (opts.placeholderKey) inp.dataset.i18nDynamicPh = opts.placeholderKey; // applyI18n refreshes open forms too
    inp.setAttribute("enterkeyhint", "done");
    inp.setAttribute("autocomplete", "off");
    inp.setAttribute("autocorrect", "off");
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "inline-creator-ok";
    ok.textContent = "✓";
    ok.title = tr("btn.ok");
    form.appendChild(inp);
    form.appendChild(ok);
    btn.replaceWith(form);
    inp.focus();

    let submitting = false, closed = false;
    function revert() {
      if (closed) return;
      closed = true;
      if (form.parentNode) form.replaceWith(btn);
    }
    async function submit() {
      const name = inp.value.trim();
      if (!name || submitting) return;
      submitting = true;
      inp.disabled = true;
      ok.disabled = true;
      try {
        await opts.onSubmit(name);
      } catch (e) {
        showToast(tr("toast.createFailed", { msg: e.message }), true);
        submitting = false;
        inp.disabled = false;
        ok.disabled = false;
        inp.focus();
        return;
      }
      revert(); // restore the button after success (list/board re-render wholesale right after, so this is harmless)
    }
    inp.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") revert();
    });
    ok.addEventListener("click", submit);
    inp.addEventListener("blur", () => {
      // deferred check: clicking ✓ fires blur first; by then submitting is already true, so do not restore
      setTimeout(() => { if (!closed && !submitting && !inp.value.trim()) revert(); }, 120);
    });
  });
  return wrap;
}

/* ================= field select component (datalist is unusable on iOS Safari, uniformly replaced) ================= */
const CUSTOM_OPT = "__custom__";

/* candidate values per field: Category uses existing project values; Effort presets 小/中/大 + existing values; Priority is fixed to 高/中/低 */
function fieldSuggestions(field) {
  if (field === "category") return [...new Set(state.tasks.map(t => t.category).filter(Boolean))];
  if (field === "effort") return [...new Set(["小", "中", "大", ...state.tasks.map(t => t.effort).filter(Boolean)])];
  if (field === "priority") return ["高", "中", "低"];
  return [];
}

function fillSelectOptions(sel, field, current) {
  const vals = fieldSuggestions(field);
  if (current && !vals.includes(current)) vals.push(current);
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = tr("select.none");
  sel.appendChild(empty);
  for (const v of vals) {
    const o = document.createElement("option");
    o.value = v; o.textContent = v;
    sel.appendChild(o);
  }
  const c = document.createElement("option");
  c.value = CUSTOM_OPT;
  c.textContent = tr("select.custom");
  sel.appendChild(c);
  sel.value = current || "";
}

/* commit-style select: used in the detail panel and list inline editing; onCommit fires on selection; picking 自定义… swaps in a text input */
function makeSelectOrCustom(opts) {
  const wrap = document.createElement("span");
  wrap.className = "sel-custom";
  const sel = document.createElement("select");
  fillSelectOptions(sel, opts.field, opts.value);
  sel.addEventListener("change", () => {
    if (sel.value !== CUSTOM_OPT) { opts.onCommit(sel.value); return; }
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "sel-custom-input";
    inp.placeholder = tr("select.customPrompt");
    inp.setAttribute("autocomplete", "off");
    inp.setAttribute("autocorrect", "off");
    sel.replaceWith(inp);
    inp.focus();
    let done = false;
    const finish = v => { if (!done) { done = true; opts.onCommit(v); } };
    inp.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); finish(inp.value.trim()); }
      else if (e.key === "Escape") { done = true; render(); } // abort, restore the select
    });
    inp.addEventListener("blur", () => setTimeout(() => finish(inp.value.trim()), 100));
  });
  wrap.appendChild(sel);
  return wrap;
}

/* value-style select: used in the create dialog; the final value is read via wrap.getValue() on submit */
function makeDialogSelect(field) {
  const wrap = document.createElement("span");
  wrap.className = "sel-custom sel-custom-dialog";
  const sel = document.createElement("select");
  fillSelectOptions(sel, field, "");
  const inp = document.createElement("input");
  inp.type = "text";
  inp.className = "sel-custom-input";
  inp.placeholder = tr("select.customValue");
  inp.setAttribute("autocomplete", "off");
  inp.setAttribute("autocorrect", "off");
  inp.style.display = "none";
  sel.addEventListener("change", () => {
    const isCustom = sel.value === CUSTOM_OPT;
    inp.style.display = isCustom ? "" : "none";
    if (isCustom) inp.focus();
  });
  wrap.appendChild(sel);
  wrap.appendChild(inp);
  wrap.getValue = () => (sel.value === CUSTOM_OPT ? inp.value.trim() : sel.value);
  return wrap;
}

/* On iOS, the first tap on an empty date input auto-commits today and closes the picker:
   on touch devices, pre-fill today on pointerdown when empty, so the picker opens starting from today and can be scrolled/changed normally */
function fixIOSDateInput(inp) {
  if (!window.matchMedia("(pointer: coarse)").matches) return;
  inp.addEventListener("pointerdown", () => { if (!inp.value) inp.value = fmtDate(today()); });
}

/*
 * New-task dialog (replaces inline input; all fields filled in at once).
 * prefill: { section?, start_on?, due_on? } — list/board pass section; timeline blank-area clicks also pass dates.
 * Name is required (create button disabled while empty); Enter = create (except during IME composition); Esc/overlay/✕/cancel closes.
 */
function openTaskDialog(prefill) {
  prefill = prefill || {};
  const ov = document.createElement("div");
  ov.className = "task-dialog-overlay";
  ov.innerHTML = `
  <div class="task-dialog" role="dialog" aria-label="${tr("dlg.newTask")}">
    <div class="td-header"><span>${tr("dlg.newTask")}</span><button type="button" class="td-close" title="${tr("btn.close")}">✕</button></div>
    <div class="td-body">
      <label>${tr("field.name")} *</label>
      <input class="td-name" type="text" placeholder="${tr("field.namePh")}" enterkeyhint="done" autocomplete="off" autocorrect="off">
      <label>${tr("field.section")}</label>
      <select class="td-section"></select>
      <label>${tr("field.assignee")}</label>
      <input class="td-assignee" type="text" list="dl-assignees" autocomplete="off" placeholder="${tr("field.assignee")}">
      <div class="td-row">
        <div><label>${tr("field.start")}</label><input class="td-start" type="date"></div>
        <div><label>${tr("field.due")}</label><input class="td-due" type="date"></div>
      </div>
      <label>Category</label>
      <div class="td-slot" data-f="category"></div>
      <div class="td-row">
        <div><label>Effort</label><div class="td-slot" data-f="effort"></div></div>
        <div><label>Priority</label><div class="td-slot" data-f="priority"></div></div>
      </div>
    </div>
    <div class="td-footer">
      <button type="button" class="td-cancel">${tr("btn.cancel")}</button>
      <button type="button" class="td-submit" disabled>${tr("btn.create")}</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  // creating a subtask: show which parent it lands under
  if (prefill.parent_id) {
    const p = taskById(prefill.parent_id);
    const hint = document.createElement("div");
    hint.className = "td-parent-hint";
    hint.textContent = tr("task.subtaskOf", { name: p ? p.name : "" });
    ov.querySelector(".td-header").after(hint);
  }

  const $q = sel => ov.querySelector(sel);
  const nameInp = $q(".td-name"), sel = $q(".td-section");
  const submitBtn = $q(".td-submit"), cancelBtn = $q(".td-cancel");
  for (const s of state.sections) {
    const o = document.createElement("option");
    o.value = s; o.textContent = s;
    sel.appendChild(o);
  }
  sel.value = prefill.section && state.sections.includes(prefill.section) ? prefill.section : state.sections[0];
  // Category / Effort / Priority: select + custom (iOS datalist unusable)
  const catF = makeDialogSelect("category");
  const effF = makeDialogSelect("effort");
  const priF = makeDialogSelect("priority");
  $q('[data-f="category"]').replaceWith(catF);
  $q('[data-f="effort"]').replaceWith(effF);
  $q('[data-f="priority"]').replaceWith(priF);
  // iOS empty date inputs auto-commit today on first tap and close; pre-fill today uniformly (timeline click-create overwrites with the tapped date)
  $q(".td-start").value = prefill.start_on || fmtDate(today());
  $q(".td-due").value = prefill.due_on || fmtDate(today());

  let busy = false;
  function close() {
    document.removeEventListener("keydown", onKey, true);
    ov.remove();
  }
  function onKey(e) {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
  }
  document.addEventListener("keydown", onKey, true);
  $q(".td-close").addEventListener("click", close);
  cancelBtn.addEventListener("click", close);
  ov.addEventListener("click", e => { if (e.target === ov) close(); });

  nameInp.addEventListener("input", () => { submitBtn.disabled = !nameInp.value.trim(); });
  async function submit() {
    const name = nameInp.value.trim();
    if (!name || busy) return;
    busy = true;
    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    try {
      await createTask({
        name,
        section: sel.value,
        ...(prefill.parent_id ? { parent_id: prefill.parent_id } : {}),
        assignee: $q(".td-assignee").value.trim(),
        start_on: $q(".td-start").value || null,
        due_on: $q(".td-due").value || null,
        category: catF.getValue(),
        effort: effF.getValue(),
        priority: priF.getValue(),
      });
      close();
    } catch (e) {
      showToast(tr("toast.createFailed", { msg: e.message }), true);
      busy = false;
      submitBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  }
  submitBtn.addEventListener("click", submit);
  ov.querySelectorAll("input").forEach(inp => inp.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.isComposing && inp.type !== "date") { e.preventDefault(); submit(); }
  }));
  // auto-focus the name input on desktop only (on mobile, avoid popping the keyboard and disturbing date/other fields)
  if (!window.matchMedia("(max-width: 768px)").matches) {
    setTimeout(() => nameInp.focus(), 0);
  }
}

/* ================= API ================= */
/* token auth: the token lives in localStorage and every request automatically carries the Authorization: Bearer header.
   On 401 the token is cleared and the login overlay is shown. In --no-auth mode everything works without a token. */
const TOKEN_KEY = "mini_asana_token";
function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (_) { return ""; } }
function setToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch (_) {} }
function clearToken() { try { localStorage.removeItem(TOKEN_KEY); } catch (_) {} }

async function api(method, url, body) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  const tok = getToken();
  if (tok) headers["Authorization"] = "Bearer " + tok;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    clearToken();
    showLogin();
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || (method + " " + url + " -> " + res.status));
  }
  return res.json();
}
/* ---------- projects ---------- */
const PROJECT_KEY = "mini_asana_project";
/* project-scoped API: /api/projects/<pid><path>; legacy servers (no projects API) fall back to /api<path> */
function papi(method, path, body) {
  const url = state.legacy
    ? "/api" + path
    : "/api/projects/" + encodeURIComponent(state.projectId) + path;
  return api(method, url, body);
}
function activeProject() { return state.projects.find(p => p.id === state.projectId) || null; }

async function loadProjects() {
  let r;
  try {
    r = await api("GET", "/api/projects");
  } catch (e) {
    if (e.message === "unauthorized") throw e;
    // legacy server has no projects API: fall back to single-project mode (tasks use old paths like /api/tasks)
    state.legacy = true;
    state.projects = [];
    state.projectId = null;
    return;
  }
  state.legacy = false;
  state.projects = r.projects || [];
  let active = null;
  try { active = localStorage.getItem(PROJECT_KEY); } catch (_) {}
  if (!active || !state.projects.some(p => p.id === active)) {
    active = state.projects[0] ? state.projects[0].id : null;
  }
  state.projectId = active;
  try { localStorage.setItem(PROJECT_KEY, active || ""); } catch (_) {}
}

async function switchProject(id) {
  if (!id || id === state.projectId) return;
  state.projectId = id;
  try { localStorage.setItem(PROJECT_KEY, id); } catch (_) {}
  clearTLSelect();
  closeDetail();
  try {
    await loadAll();
  } catch (e) {
    showToast(tr("toast.loadProjectFailed", { msg: e.message }), true);
  }
  render();
}

async function createProject(name) {
  const p = await api("POST", "/api/projects", { name });
  state.projects.push(p);
  renderProjects();
  await switchProject(p.id);
}

function removeProject(p) {
  confirmDialog(tr("confirm.deleteProject", { name: p.name }), async () => {
    try {
      await api("DELETE", "/api/projects/" + encodeURIComponent(p.id));
      state.projects = state.projects.filter(x => x.id !== p.id);
      if (state.projectId === p.id) {
        state.projectId = state.projects[0] ? state.projects[0].id : null;
        try { localStorage.setItem(PROJECT_KEY, state.projectId || ""); } catch (_) {}
        clearTLSelect();
        closeDetail();
        await loadAll();
      }
      render();
    } catch (e) {
      showToast(tr("toast.deleteProjectFailed", { msg: e.message }), true);
    }
  });
}

/* sidebar project list: click to switch; hover reveals ✎ rename / 🗑 delete (🗑 hidden when only one project remains) */
function renderProjects() {
  const box = $("#project-list");
  if (!box) return;
  if (box.querySelector(".project-rename-form")) return; // do not rebuild while a rename input is active
  box.innerHTML = "";
  if (projectCreatorEl) projectCreatorEl.style.display = state.legacy ? "none" : "";
  if (state.legacy) return;
  for (const p of state.projects) {
    const item = document.createElement("div");
    item.className = "nav-item project-item" + (p.id === state.projectId ? " active" : "");
    item.title = p.name;
    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = p.name;
    item.appendChild(name);
    const acts = document.createElement("span");
    acts.className = "project-actions";
    const ren = document.createElement("button");
    ren.type = "button";
    ren.textContent = "✎";
    ren.title = tr("project.rename");
    ren.addEventListener("click", e => { e.stopPropagation(); startProjectRename(p, name); });
    acts.appendChild(ren);
    if (state.projects.length > 1) {
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "🗑";
      del.title = tr("project.delete");
      del.addEventListener("click", e => { e.stopPropagation(); removeProject(p); });
      acts.appendChild(del);
    }
    item.appendChild(acts);
    item.addEventListener("click", () => {
      switchProject(p.id);
      // mobile: collapse the drawer after tapping a project
      $("#sidebar").classList.remove("open");
      $("#sidebar-backdrop").classList.add("hidden");
    });
    box.appendChild(item);
  }
}

/* project rename: swap the name in place for an input + ✓ (same pattern as section rename) */
function startProjectRename(p, nameEl) {
  const form = document.createElement("span");
  form.className = "inline-creator-form project-rename-form";
  const inp = document.createElement("input");
  inp.className = "inline-input";
  inp.value = p.name;
  inp.setAttribute("enterkeyhint", "done");
  inp.setAttribute("autocomplete", "off");
  inp.setAttribute("autocorrect", "off");
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "inline-creator-ok";
  ok.textContent = "✓";
  form.appendChild(inp);
  form.appendChild(ok);
  nameEl.replaceWith(form);
  inp.focus();
  inp.select();
  let busy = false;
  async function submit() {
    const name = inp.value.trim();
    if (busy) return;
    if (!name || name === p.name) { renderProjects(); return; }
    busy = true;
    inp.disabled = true;
    ok.disabled = true;
    try {
      await api("PATCH", "/api/projects/" + encodeURIComponent(p.id), { name });
      p.name = name;
      renderProjects();
      renderStats(); // topbar title follows the project name
    } catch (e) {
      showToast(tr("toast.renameFailed", { msg: e.message }), true);
      busy = false;
      inp.disabled = false;
      ok.disabled = false;
      inp.focus();
    }
  }
  form.addEventListener("click", e => e.stopPropagation());
  inp.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    else if (e.key === "Escape") renderProjects();
  });
  ok.addEventListener("click", submit);
  inp.addEventListener("blur", () => {
    setTimeout(() => { if (!busy && !inp.value.trim()) renderProjects(); }, 120);
  });
}

async function loadAll() {
  const db = await papi("GET", "/tasks");
  state.tasks = db.tasks;
  state.sections = db.sections;
}
/* startup flow: fetch the project list first (determines projectId), then load that project's tasks */
async function boot() {
  await loadProjects();
  await loadAll();
}
let projectCreatorEl = null; // inline creator for the "＋ 新建项目" button (mounted in init)

async function updateTask(id, patch, opts) {
  const t = taskById(id);
  if (t) Object.assign(t, patch);
  try {
    const saved = await papi("PUT", "/tasks/" + encodeURIComponent(id), patch);
    if (t) Object.assign(t, saved);
  } catch (e) {
    showToast(tr("toast.saveFailed", { msg: e.message }), true);
    await loadAll();
  }
  if (!opts || !opts.silent) render(); // silent: skipped during batch commits; the caller renders once at the end
}
async function createTask(payload) {
  const t = await papi("POST", "/tasks", payload);
  state.tasks.push(t);
  if (!state.sections.includes(t.section)) state.sections.push(t.section);
  render();
  return t;
}
async function deleteTask(id) {
  await papi("DELETE", "/tasks/" + encodeURIComponent(id));
  state.tasks.forEach(t => { if (t.parent_id === id) delete t.parent_id; }); // orphaned subtasks become top-level
  state.tasks = state.tasks.filter(t => t.id !== id);
  if (state.detailId === id) closeDetail();
  render();
}
async function moveTask(taskId, targetSection, targetIndex) {
  const t = taskById(taskId);
  if (!t) return;
  const srcSection = t.section;
  // optimistic update
  const siblings = sectionTasks(targetSection).filter(x => x.id !== taskId);
  t.section = targetSection;
  if (srcSection !== targetSection) childrenOf(taskId).forEach(k => { k.section = targetSection; }); // subtasks follow the parent
  siblings.splice(targetIndex, 0, t);
  siblings.forEach((x, i) => { x.order = i; });
  render();
  try {
    if (srcSection !== targetSection) {
      await papi("PUT", "/tasks/" + encodeURIComponent(taskId), { section: targetSection });
      await papi("POST", "/reorder", { section: srcSection, ids: sectionTasks(srcSection).map(x => x.id) });
    }
    await papi("POST", "/reorder", { section: targetSection, ids: siblings.map(x => x.id) });
  } catch (e) {
    showToast(tr("toast.moveFailed", { msg: e.message }), true);
    await loadAll();
    render();
  }
}
/* re-sequence the flat display order of a whole section after local reordering */
function resequenceSection(sec) { flatSectionList(sec).forEach((t, i) => { t.order = i; }); }

/* unified list-view drop operation: change section and/or parent, then re-sequence order.
   dest = { section, parentId (null = top-level), index (position within the destination sibling group) } */
async function placeTask(taskId, dest) {
  const t = taskById(taskId);
  if (!t) return;
  const parentId = dest.parentId || null;
  if (parentId) {
    if (parentId === taskId) return;
    const p = taskById(parentId);
    if (!p || p.parent_id) return; // parent must exist and be top-level (one-level rule)
    if (hasChildren(taskId)) { showToast(tr("toast.parentHasChildren"), true); return; }
  }
  const srcSection = t.section, srcParent = t.parent_id || null;
  // optimistic local update
  t.section = dest.section;
  if (parentId) t.parent_id = parentId; else delete t.parent_id;
  const sibs = (parentId ? childrenOf(parentId) : topTasks(dest.section)).filter(x => x.id !== taskId);
  sibs.splice(Math.min(dest.index, sibs.length), 0, t);
  if (srcSection !== dest.section) resequenceSection(srcSection);
  resequenceSection(dest.section);
  render();
  try {
    const patch = {};
    if (srcSection !== dest.section) patch.section = dest.section;
    if (srcParent !== parentId) patch.parent_id = parentId;
    if (Object.keys(patch).length) await papi("PUT", "/tasks/" + encodeURIComponent(taskId), patch);
    if (srcSection !== dest.section) await papi("POST", "/reorder", { section: srcSection, ids: flatSectionList(srcSection).map(x => x.id) });
    await papi("POST", "/reorder", { section: dest.section, ids: flatSectionList(dest.section).map(x => x.id) });
  } catch (e) {
    showToast(tr("toast.moveFailed", { msg: e.message }), true);
    await loadAll();
    render();
  }
}

async function addSection(name) {
  await papi("POST", "/sections", { name });
  state.sections.push(name);
  render();
}
/* section rename: swap the h3 title in place for an input + ✓ (replaces prompt) */
function startSectionRename(oldName, h3) {
  if (!h3) return;
  const form = document.createElement("span");
  form.className = "inline-creator-form";
  const inp = document.createElement("input");
  inp.className = "inline-input";
  inp.value = oldName;
  inp.setAttribute("enterkeyhint", "done");
  inp.setAttribute("autocomplete", "off");
  inp.setAttribute("autocorrect", "off");
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "inline-creator-ok";
  ok.textContent = "✓";
  form.appendChild(inp);
  form.appendChild(ok);
  h3.textContent = "";
  h3.appendChild(form);
  inp.focus();
  inp.select();
  let busy = false;
  async function submit() {
    const name = inp.value.trim();
    if (busy) return;
    if (!name || name === oldName) { render(); return; }
    busy = true;
    inp.disabled = true;
    ok.disabled = true;
    try {
      await papi("PUT", "/sections/" + encodeURIComponent(oldName), { name });
      state.sections = state.sections.map(s => (s === oldName ? name : s));
      state.tasks.forEach(t => { if (t.section === oldName) t.section = name; });
      render();
    } catch (e) {
      showToast(tr("toast.renameFailed", { msg: e.message }), true);
      busy = false;
      inp.disabled = false;
      ok.disabled = false;
      inp.focus();
    }
  }
  inp.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    else if (e.key === "Escape") render();
  });
  ok.addEventListener("click", submit);
  inp.addEventListener("blur", () => {
    setTimeout(() => { if (!busy && !inp.value.trim()) render(); }, 120);
  });
}
async function removeSection(name) {
  confirmDialog(tr("confirm.deleteSection", { name }), async () => {
    try {
      const r = await papi("DELETE", "/sections/" + encodeURIComponent(name));
      state.sections = r.sections;
      state.tasks.forEach(t => { if (t.section === name) t.section = r.moved_to; });
      render();
    } catch (e) {
      showToast(tr("toast.deleteSectionFailed", { msg: e.message }), true);
    }
  });
}

/* ================= render entry ================= */
function render() {
  renderStats();
  renderProjects();
  renderDatalists();
  $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.view === state.view));
  const c = $("#view-container");
  // save scroll positions before re-rendering (view container + the timeline/board's own scroll layers) and restore afterwards, avoiding jumps/lost positions after drag commits
  const savedScroll = [["#view-container", c], ["#timeline", $("#timeline")], ["#board", $("#board")]]
    .filter(([, el]) => el)
    .map(([sel, el]) => [sel, el.scrollLeft, el.scrollTop]);
  c.innerHTML = "";
  if (state.view === "list") renderList(c);
  else if (state.view === "board") renderBoard(c);
  else if (state.view === "timeline") renderTimeline(c);
  else if (state.view === "calendar") renderCalendar(c);
  for (const [sel, l, t] of savedScroll) {
    const el = sel === "#view-container" ? c : $(sel);
    if (el) { el.scrollLeft = l; el.scrollTop = t; }
  }
  if (state.detailId) {
    if (taskById(state.detailId)) renderDetail();
    else closeDetail();
  }
}

function renderStats() {
  const ap = activeProject();
  if (ap) $("#project-title").textContent = ap.name; // topbar title = current project name
  const open = state.tasks.filter(t => !t.completed).length;
  const done = state.tasks.length - open;
  if (window.matchMedia("(max-width: 768px)").matches) {
    $("#stats").innerHTML = `<b>${open}</b> ${tr("stats.openShort")}`;
  } else {
    $("#stats").innerHTML = `<b>${open}</b> ${tr("stats.openLong", { done })}`;
  }
}

function renderDatalists() {
  const assignees = [...new Set(state.tasks.map(t => t.assignee).filter(Boolean))];
  $("#dl-assignees").innerHTML = assignees.map(a => `<option value="${esc(a)}">`).join("");
}

/* inline editing: click a field to turn it into an input */
function inlineEdit(value, onCommit, opts) {
  opts = opts || {};
  const span = document.createElement(opts.textarea ? "textarea" : "input");
  if (!opts.textarea) span.type = opts.type || "text";
  span.value = value || "";
  span.className = "inline-input";
  if (opts.list) span.setAttribute("list", opts.list);
  if (opts.placeholder) span.placeholder = opts.placeholder;
  let committed = false;
  function commit() {
    if (committed) return;
    committed = true;
    const v = span.value.trim();
    if (v !== (value || "")) onCommit(v);
  }
  span.addEventListener("blur", commit);
  span.addEventListener("keydown", e => {
    if (e.key === "Enter" && !opts.textarea) { commit(); span.blur(); }
    if (e.key === "Escape") { committed = true; span.value = value || ""; span.blur(); render(); }
  });
  return span;
}

function makeCheckbox(task) {
  const b = document.createElement("button");
  b.className = "checkbox" + (task.completed ? " done" : "");
  b.textContent = task.completed ? "✓" : "";
  b.title = task.completed ? tr("task.markUndone") : tr("task.markDone");
  b.addEventListener("click", e => {
    e.stopPropagation();
    updateTask(task.id, { completed: !task.completed });
  });
  return b;
}

/* ================= list view ================= */
function renderList(container) {
  for (const sec of state.sections) {
    const secEl = document.createElement("div");
    secEl.className = "list-section";
    secEl.dataset.section = sec;

    const header = document.createElement("div");
    header.className = "list-section-header";
    const tasks = sectionTasks(sec);
    header.innerHTML = `<h3>${esc(sec)}</h3><span class="count">${tasks.length}</span>
      <span class="section-actions">
        <button data-act="rename" title="${tr("section.rename")}">✎</button>
        <button data-act="delete" title="${tr("section.delete")}">🗑</button>
      </span>`;
    header.querySelector('[data-act="rename"]').addEventListener("click", () => startSectionRename(sec, header.querySelector("h3")));
    header.querySelector('[data-act="delete"]').addEventListener("click", () => removeSection(sec));
    // dropping onto a section header = move to the end of that section
    header.addEventListener("dragover", e => { e.preventDefault(); });
    header.addEventListener("drop", e => {
      e.preventDefault();
      const id = e.dataTransfer.getData("text/task-id");
      if (id) placeTask(id, { section: sec, parentId: null, index: topTasks(sec).filter(t => t.id !== id).length });
    });
    secEl.appendChild(header);

    for (const task of topTasks(sec)) {
      secEl.appendChild(makeListRow(task, sec, {}));
      if (!isCollapsed(task.id)) {
        for (const sub of childrenOf(task.id)) secEl.appendChild(makeListRow(sub, sec, { isSub: true }));
      }
    }

    // add task: pop up the form dialog to fill all fields at once
    const addTaskBtn = document.createElement("button");
    addTaskBtn.className = "add-task-btn";
    addTaskBtn.textContent = tr("task.add");
    addTaskBtn.addEventListener("click", () => openTaskDialog({ section: sec }));
    secEl.appendChild(addTaskBtn);
    // dropping on blank area = move to end (row/header drops already stopPropagation)
    secEl.addEventListener("dragover", e => e.preventDefault());
    secEl.addEventListener("drop", e => {
      e.preventDefault();
      const id = e.dataTransfer.getData("text/task-id");
      if (id) placeTask(id, { section: sec, parentId: null, index: topTasks(sec).filter(t => t.id !== id).length });
    });
    container.appendChild(secEl);
  }
}

/* list touch-drag helpers: clear drop highlight / hit testing (row -> before/after; section -> end) */
function clearListDropMarks() {
  $$(".list-row.drop-before, .list-row.drop-after, .list-row.drop-into").forEach(r => r.classList.remove("drop-before", "drop-after", "drop-into"));
}
/* list drop hit testing: center zone (25%-75%) of a valid top-level row = make-subtask ("into");
   top/bottom halves = reorder before/after (on a subtask row: within the same parent);
   section background = append as top-level ("end"); "invalid" = one-level rule forbids it (ignored) */
function listDropTarget(x, y, selfRow, dragTask) {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  const row = hit.closest(".list-row");
  if (row && row !== selfRow) {
    const secEl = row.closest(".list-section");
    if (!secEl) return null;
    const r = row.getBoundingClientRect();
    const rel = (y - r.top) / r.height;
    const rowTask = taskById(row.dataset.taskId);
    const isSub = row.classList.contains("sub-row");
    const hasKids = dragTask ? hasChildren(dragTask.id) : false;
    if (isSub && hasKids) return { row, section: secEl.dataset.section, zone: "invalid" }; // a parent can't become a sibling subtask
    if (!isSub && rowTask && dragTask && dragTask.id !== rowTask.id && !hasKids && rel >= 0.25 && rel <= 0.75) {
      return { row, section: secEl.dataset.section, zone: "into", parentId: rowTask.id };
    }
    return {
      row, section: secEl.dataset.section,
      zone: rel < 0.5 ? "before" : "after",
      parentId: isSub && rowTask ? rowTask.parent_id || null : null,
    };
  }
  const secEl = hit.closest(".list-section");
  if (secEl) return { row: null, section: secEl.dataset.section, zone: "end", parentId: null };
  return null;
}

function makeListRow(task, sec, opts) {
  opts = opts || {};
  const isSub = !!opts.isSub;
  const row = document.createElement("div");
  row.className = "list-row" + (task.completed ? " task-done" : "") + (isSub ? " sub-row" : "");
  row.dataset.taskId = task.id;

  const handle = document.createElement("span");
  handle.className = "drag-handle";
  handle.textContent = "⠿";
  handle.draggable = true;
  handle.title = tr("task.dragHandle");
  handle.addEventListener("dragstart", e => {
    e.dataTransfer.setData("text/task-id", task.id);
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setDragImage(row, 20, 12); } catch (_) {}
    row.classList.add("dragging");
    dragTaskId = task.id;
  });
  handle.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    dragTaskId = null;
    clearListDropMarks();
  });
  // touch: hold the handle 180ms to start dragging (handle has touch-action:none, no scroll conflict)
  attachTouchDrag(handle, {
    pressDelay: 180,
    makeGhost: () => {
      const g = row.cloneNode(true);
      g.style.width = row.offsetWidth + "px";
      g.classList.remove("touch-dragging");
      return g;
    },
    onMove: (x, y) => {
      clearListDropMarks();
      const t = listDropTarget(x, y, row, task);
      if (t && t.row) {
        if (t.zone === "into") t.row.classList.add("drop-into");
        else if (t.zone === "before") t.row.classList.add("drop-before");
        else if (t.zone === "after") t.row.classList.add("drop-after");
      }
    },
    onDrop: (x, y) => {
      const t = listDropTarget(x, y, row, task);
      if (!t || t.zone === "invalid") return;
      if (t.zone === "into") {
        placeTask(task.id, { section: t.section, parentId: t.parentId, index: childrenOf(t.parentId).filter(x => x.id !== task.id).length });
        return;
      }
      if (t.zone === "end" || !t.row) {
        placeTask(task.id, { section: t.section, parentId: null, index: topTasks(t.section).filter(x => x.id !== task.id).length });
        return;
      }
      const rowTask = taskById(t.row.dataset.taskId);
      if (!rowTask) return;
      const sibs = (t.parentId ? childrenOf(t.parentId) : topTasks(t.section)).filter(x => x.id !== task.id);
      let idx = sibs.findIndex(x => x.id === rowTask.id);
      if (idx < 0) idx = sibs.length; else if (t.zone === "after") idx += 1;
      placeTask(task.id, { section: t.section, parentId: t.parentId, index: idx });
    },
    onEnd: clearListDropMarks,
  });
  row.appendChild(handle);

  // subtask rows indent; parent rows get a disclosure triangle; other rows an alignment spacer
  if (isSub) {
    const ind = document.createElement("span");
    ind.className = "sub-indent";
    row.appendChild(ind);
  } else if (hasChildren(task.id)) {
    const tog = document.createElement("button");
    tog.type = "button";
    tog.className = "sub-toggle";
    const collapsed = isCollapsed(task.id);
    tog.textContent = collapsed ? "▸" : "▾";
    tog.title = collapsed ? tr("sub.expand") : tr("sub.collapse");
    tog.addEventListener("click", e => {
      e.stopPropagation();
      setCollapsed(task.id, !collapsed);
      render();
    });
    row.appendChild(tog);
  } else {
    const sp = document.createElement("span");
    sp.className = "sub-toggle sub-toggle-spacer";
    row.appendChild(sp);
  }

  row.appendChild(makeCheckbox(task));

  // task name: single click opens the detail panel (renaming happens there; consistent with board/timeline/calendar)
  const nameCell = document.createElement("div");
  nameCell.className = "task-name";
  const nameView = document.createElement("span");
  nameView.textContent = task.name;
  nameView.style.cursor = "pointer";
  nameView.title = tr("task.openDetail");
  nameView.addEventListener("click", e => {
    e.stopPropagation();
    if (!clickSuppressed()) openDetail(task.id);
  });
  nameCell.appendChild(nameView);
  // parent rows: subtle completed/total subtask progress badge
  if (!isSub) {
    const kids = childrenOf(task.id);
    if (kids.length) {
      const done = kids.filter(k => k.completed).length;
      const badge = document.createElement("span");
      badge.className = "sub-progress";
      badge.textContent = done + "/" + kids.length;
      badge.title = tr("sub.progress", { done, total: kids.length });
      nameCell.appendChild(badge);
    }
  }
  row.appendChild(nameCell);

  // assignee
  row.appendChild(makeCell(task, "assignee", { list: "dl-assignees", placeholder: tr("field.assignee") }));
  // due date
  row.appendChild(makeCell(task, "due_on", { type: "date", cls: "cell-date" }));
  // Category / Effort / Priority (becomes select + custom after click)
  row.appendChild(makeCell(task, "category", { pill: true }));
  row.appendChild(makeCell(task, "effort", { placeholder: tr("field.effort") }));
  row.appendChild(makeCell(task, "priority", { pri: true }));

  const del = document.createElement("button");
  del.className = "del-btn";
  del.textContent = "✕";
  del.title = tr("task.delete");
  del.addEventListener("click", e => {
    e.stopPropagation();
    confirmDialog(tr("confirm.deleteTask", { name: task.name }), () => {
      deleteTask(task.id).catch(err => showToast(tr("toast.deleteFailed", { msg: err.message }), true));
    });
  });
  row.appendChild(del);

  // clicks on non-interactive blank areas of the row (name-cell padding, row body) -> open details;
  // clicks on the checkbox / field inline editors / handle / delete button target those elements and never hit this branch
  row.addEventListener("click", e => {
    if (e.target !== row && e.target !== nameCell) return;
    if (!clickSuppressed()) openDetail(task.id);
  });

  // drop target: center zone (25%-75%) of a top-level row = make-subtask ("into"), edges = reorder
  row.addEventListener("dragover", e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = row.getBoundingClientRect();
    const rel = (e.clientY - rect.top) / rect.height;
    const intoOk = !isSub && dragTaskId && dragTaskId !== task.id && !hasChildren(dragTaskId) && rel >= 0.25 && rel <= 0.75;
    row.classList.toggle("drop-into", !!intoOk);
    row.classList.toggle("drop-before", !intoOk && rel < 0.5);
    row.classList.toggle("drop-after", !intoOk && rel >= 0.5);
    row.dataset.dropPos = intoOk ? "into" : (rel < 0.5 ? "before" : "after");
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after", "drop-into"));
  row.addEventListener("drop", e => {
    e.preventDefault();
    e.stopPropagation();
    const id = e.dataTransfer.getData("text/task-id");
    row.classList.remove("drop-before", "drop-after", "drop-into");
    if (!id || id === task.id) return;
    const pos = row.dataset.dropPos;
    if (pos === "into" && !isSub) {
      placeTask(id, { section: task.section, parentId: task.id, index: childrenOf(task.id).filter(x => x.id !== id).length });
      return;
    }
    if (isSub && hasChildren(id)) { showToast(tr("toast.parentHasChildren"), true); return; } // one-level rule
    const sibs = (isSub ? childrenOf(task.parent_id) : topTasks(sec)).filter(x => x.id !== id);
    let idx = sibs.findIndex(x => x.id === task.id);
    if (idx < 0) idx = sibs.length; else if (pos === "after") idx += 1;
    placeTask(id, { section: sec, parentId: isSub ? task.parent_id : null, index: idx });
  });
  return row;
}

function makeCell(task, field, opts) {
  const cell = document.createElement("div");
  cell.className = "cell" + (opts.cls ? " " + opts.cls : "");
  function showView() {
    cell.innerHTML = "";
    const v = task[field];
    const view = document.createElement("span");
    if (opts.pill) view.innerHTML = catPill(v);
    else if (opts.pri) view.innerHTML = priHtml(v);
    else view.innerHTML = v ? esc(v) : '<span class="pill-empty muted">—</span>';
    view.style.cursor = "pointer";
    view.title = tr("cell.clickEdit");
    view.addEventListener("click", () => {
      // Category / Effort / Priority use select+custom (datalist unusable on iOS)
      if (field === "category" || field === "effort" || field === "priority") {
        const w = makeSelectOrCustom({
          field,
          value: task[field],
          onCommit: v => updateTask(task.id, { [field]: v }),
        });
        cell.innerHTML = "";
        cell.appendChild(w);
        w.querySelector("select").focus();
        return;
      }
      const inp = inlineEdit(task[field], nv => updateTask(task.id, { [field]: nv }), opts);
      cell.innerHTML = "";
      cell.appendChild(inp);
      if (opts.type === "date") fixIOSDateInput(inp);
      inp.focus();
      if (opts.type === "date" && inp.showPicker) { try { inp.showPicker(); } catch (_) {} }
    });
    cell.appendChild(view);
  }
  showView();
  return cell;
}

/* ================= board view ================= */
function renderBoard(container) {
  const board = document.createElement("div");
  board.id = "board";
  for (const sec of state.sections) {
    const col = document.createElement("div");
    col.className = "board-col";
    col.dataset.section = sec;
    const tasks = sectionTasks(sec);
    const head = document.createElement("div");
    head.className = "board-col-header";
    head.innerHTML = `<h3>${esc(sec)}</h3><span class="count">${tasks.length}</span>
      <span class="section-actions" style="display:flex">
        <button data-act="rename" title="${tr("column.rename")}">✎</button>
        <button data-act="delete" title="${tr("column.delete")}">🗑</button>
      </span>`;
    head.querySelector('[data-act="rename"]').addEventListener("click", () => startSectionRename(sec, head.querySelector("h3")));
    head.querySelector('[data-act="delete"]').addEventListener("click", () => removeSection(sec));
    col.appendChild(head);

    const cards = document.createElement("div");
    cards.className = "board-cards";
    for (const task of tasks) cards.appendChild(makeBoardCard(task, sec));
    cards.addEventListener("dragover", e => { e.preventDefault(); col.classList.add("drag-over"); });
    cards.addEventListener("dragleave", e => { if (e.target === cards) col.classList.remove("drag-over"); });
    cards.addEventListener("drop", e => {
      e.preventDefault();
      col.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/task-id");
      if (id) moveTask(id, sec, sectionTasks(sec).filter(t => t.id !== id).length);
    });
    col.appendChild(cards);

    // add task: pop up the form dialog (replaces inline input)
    const addTaskBtn = document.createElement("button");
    addTaskBtn.className = "add-task-btn";
    addTaskBtn.textContent = tr("task.add");
    addTaskBtn.addEventListener("click", () => openTaskDialog({ section: sec }));
    col.appendChild(addTaskBtn);
    board.appendChild(col);
  }
  container.appendChild(board);
}

function makeBoardCard(task, sec) {
  const card = document.createElement("div");
  card.className = "board-card" + (task.completed ? " task-done" : "");
  card.draggable = true;
  card.dataset.taskId = task.id;

  const check = makeCheckbox(task);
  check.classList.add("card-check");
  card.appendChild(check);

  const name = document.createElement("div");
  name.className = "task-name";
  name.textContent = task.name;
  card.appendChild(name);

  // subtask card: muted parent reference under the title
  if (task.parent_id) {
    const p = taskById(task.parent_id);
    if (p) {
      const pl = document.createElement("div");
      pl.className = "card-parent";
      pl.textContent = "↳ " + p.name;
      card.appendChild(pl);
    }
  }

  const meta = document.createElement("div");
  meta.className = "card-meta";
  if (task.assignee) {
    const av = document.createElement("span");
    av.className = "avatar";
    av.textContent = task.assignee[0];
    av.title = task.assignee;
    meta.appendChild(av);
  }
  if (task.due_on) {
    const d = document.createElement("span");
    d.className = "card-date";
    d.textContent = "📅 " + task.due_on.slice(5);
    meta.appendChild(d);
  }
  if (task.category) {
    const p = document.createElement("span");
    p.innerHTML = catPill(task.category);
    meta.appendChild(p);
  }
  if (task.priority) {
    const p = document.createElement("span");
    p.innerHTML = priHtml(task.priority);
    meta.appendChild(p);
  }
  if (task.effort) {
    const ef = document.createElement("span");
    ef.textContent = "⏱ " + task.effort;
    meta.appendChild(ef);
  }
  card.appendChild(meta);

  card.addEventListener("click", () => { if (!clickSuppressed()) openDetail(task.id); });
  card.addEventListener("dragstart", e => {
    e.dataTransfer.setData("text/task-id", task.id);
    e.dataTransfer.effectAllowed = "move";
    card.classList.add("dragging");
  });
  card.addEventListener("dragend", () => {
    card.classList.remove("dragging");
    $$(".board-card.drop-before").forEach(c => c.classList.remove("drop-before"));
    $$(".board-col.drag-over").forEach(c => c.classList.remove("drag-over"));
  });
  card.addEventListener("dragover", e => {
    e.preventDefault();
    e.stopPropagation();
    card.classList.add("drop-before");
  });
  card.addEventListener("dragleave", () => card.classList.remove("drop-before"));
  card.addEventListener("drop", e => {
    e.preventDefault();
    e.stopPropagation();
    card.classList.remove("drop-before");
    const id = e.dataTransfer.getData("text/task-id");
    if (!id || id === task.id) return;
    const list = sectionTasks(sec).filter(t => t.id !== id);
    const idx = list.findIndex(t => t.id === task.id);
    moveTask(id, sec, idx);
  });
  // touch: long-press 400ms to start dragging (movement >15px during the wait cancels as scroll; 10px after armed starts the real drag), drop across/within columns
  attachTouchDrag(card, {
    pressDelay: 400,
    cancelThreshold: 15,
    makeGhost: () => {
      const g = card.cloneNode(true);
      g.style.width = card.offsetWidth + "px";
      g.classList.remove("touch-dragging");
      return g;
    },
    onMove: (x, y) => {
      clearBoardDropMarks();
      const t = boardDropTarget(x, y, card);
      if (!t) return;
      if (t.card) t.card.classList.add("drop-before");
      else if (t.col) t.col.classList.add("drag-over");
    },
    onDrop: (x, y) => {
      const t = boardDropTarget(x, y, card);
      if (!t) return;
      const list = sectionTasks(t.section).filter(x => x.id !== task.id);
      let idx = list.length;
      if (t.card) {
        idx = list.findIndex(x => x.id === t.card.dataset.taskId);
        if (idx < 0) idx = list.length;
      }
      moveTask(task.id, t.section, idx);
    },
    onEnd: clearBoardDropMarks,
  });
  return card;
}

/* board touch-drag helpers */
function clearBoardDropMarks() {
  $$(".board-card.drop-before").forEach(c => c.classList.remove("drop-before"));
  $$(".board-col.drag-over").forEach(c => c.classList.remove("drag-over"));
}
function boardDropTarget(x, y, selfCard) {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  const card = hit.closest(".board-card");
  if (card && card !== selfCard) {
    const col = card.closest(".board-col");
    if (col) return { card, col, section: col.dataset.section };
  }
  const col = hit.closest(".board-col");
  if (col) return { card: null, col, section: col.dataset.section };
  return null;
}

/* ================= timeline view ================= */
const TL = { dayW: 30, nameW: 220, headerH: 34, rowH: 34, secRowH: 30 };

/*
 * Timeline row ordering: Kahn topological sort within each group.
 * - Only dependency edges inside the group (already filtered to dated tasks) are considered; cross-section dependencies do not affect ordering.
 * - Each pick from the ready set takes "earliest due date, then current order", keeping results stable and chained tasks adjacent layer by layer.
 * - On cycle detection, cycle members are appended in their original relative order — no tasks lost, no infinite loop.
 */
function topoSortTasks(tasks) {
  const ids = new Set(tasks.map(t => t.id));
  const byId = new Map(tasks.map(t => [t.id, t]));
  const indeg = new Map(tasks.map(t => [t.id, 0]));
  const succ = new Map(tasks.map(t => [t.id, []]));
  for (const t of tasks) {
    for (const depId of t.dependencies || []) {
      if (!ids.has(depId) || depId === t.id) continue;
      succ.get(depId).push(t.id);
      indeg.set(t.id, indeg.get(t.id) + 1);
    }
  }
  const sortKey = t => (t.due_on || t.start_on || "9999-12-31") + "|" + String(t.order).padStart(10, "0");
  const cmp = (a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0);
  let ready = tasks.filter(t => indeg.get(t.id) === 0);
  const out = [];
  while (ready.length) {
    ready.sort(cmp);
    const t = ready.shift();
    out.push(t);
    for (const sid of succ.get(t.id)) {
      const d = indeg.get(sid) - 1;
      indeg.set(sid, d);
      if (d === 0) ready.push(byId.get(sid));
    }
  }
  if (out.length < tasks.length) { // cycle present: remaining tasks appended in original relative order
    const placed = new Set(out.map(t => t.id));
    for (const t of tasks) if (!placed.has(t.id)) out.push(t);
  }
  return out;
}


/*
 * Click / drag-select on timeline blank areas to create tasks.
 * - Click blank (not a bar): open the create dialog, section = the row's section, start = due = clicked date
 * - Mouse held and dragged horizontally >5px: drag-select a date range (dashed-box visual feedback), start = drag start, due = drag end
 * - Touch keeps scroll priority; only tap (click) triggers single-day creation; interactions on bars are unaffected
 */
function attachTrackCreate(track, sec, rangeStart) {
  const dateAtX = px => addDays(rangeStart, Math.max(0, Math.floor(px / TL.dayW)));
  let mouseHandledAt = 0;

  track.addEventListener("pointerdown", e => {
    if (e.pointerType === "touch") return; // touch goes through click (tap); do not disturb scrolling
    if (e.button > 0 || e.target.closest(".tl-bar")) return;
    e.preventDefault();
    const rect = track.getBoundingClientRect();
    const startX = e.clientX - rect.left;
    let moved = false, sel = null;
    function onMove(ev) {
      const curX = ev.clientX - rect.left;
      if (!moved && Math.abs(curX - startX) > 5) {
        moved = true;
        sel = document.createElement("div");
        sel.className = "tl-range-sel";
        track.appendChild(sel);
      }
      if (moved) {
        sel.style.left = Math.min(startX, curX) + "px";
        sel.style.width = Math.max(TL.dayW, Math.abs(curX - startX)) + "px";
      }
    }
    function onUp(ev) {
      track.removeEventListener("pointermove", onMove);
      track.removeEventListener("pointerup", onUp);
      track.removeEventListener("pointercancel", onUp);
      mouseHandledAt = Date.now();
      const curX = ev.clientX - rect.left;
      let d1 = dateAtX(startX), d2 = dateAtX(curX);
      if (d2 < d1) { const tmp = d1; d1 = d2; d2 = tmp; }
      if (sel) sel.remove();
      openTaskDialog({
        section: sec,
        start_on: fmtDate(d1),
        due_on: fmtDate(moved ? d2 : d1),
      });
    }
    track.addEventListener("pointermove", onMove);
    track.addEventListener("pointerup", onUp);
    track.addEventListener("pointercancel", onUp);
  });

  track.addEventListener("click", e => {
    if (Date.now() - mouseHandledAt < 400) return; // mouse path already handled at pointerup
    if (e.target.closest(".tl-bar")) return;       // tap on a bar = open details, do not create
    if (clickSuppressed()) return;                 // synthetic click right after a drag
    const rect = track.getBoundingClientRect();
    const d = dateAtX(e.clientX - rect.left);
    openTaskDialog({ section: sec, start_on: fmtDate(d), due_on: fmtDate(d) });
  });
}

function renderTimeline(container) {
  const wrap = document.createElement("div");
  wrap.id = "timeline";

  // mobile: day column width 30->20px, sticky task column 220->110px (all coordinate math is based on these two values)
  const isMobile = window.matchMedia("(max-width: 768px)").matches;
  TL.dayW = isMobile ? 20 : 30;
  TL.nameW = isMobile ? 110 : 220;

  // compute the date range
  const dated = state.tasks.filter(t => t.start_on || t.due_on);
  if (!dated.length) {
    wrap.innerHTML = '<div class="tl-empty-hint">' + tr("tl.empty") + '</div>';
    container.appendChild(wrap);
    return;
  }
  let minD = null, maxD = null;
  const bars = new Map(); // id -> {start, due}
  for (const t of dated) {
    let s = parseDate(t.start_on), d = parseDate(t.due_on);
    if (!s && d) s = new Date(d);          // no start date: draw a single-day bar on the due date only, do not infer length (avoid fabricating data)
    if (!d && s) d = new Date(s);          // no due date: single day
    if (d < s) d = new Date(s);
    bars.set(t.id, { start: s, due: d, inferred: !t.start_on || !t.due_on });
    if (!minD || s < minD) minD = s;
    if (!maxD || d > maxD) maxD = d;
  }
  // align to Monday + buffer
  let rangeStart = addDays(minD, -7);
  rangeStart = addDays(rangeStart, -((rangeStart.getDay() + 6) % 7)); // align to Monday
  const rangeEnd = addDays(maxD, 14);
  const totalDays = diffDays(rangeStart, rangeEnd) + 1;
  const trackW = totalDays * TL.dayW;

  const xOf = d => diffDays(rangeStart, d) * TL.dayW;

  const inner = document.createElement("div");
  inner.className = "tl-inner";
  inner.style.width = (TL.nameW + trackW) + "px";
  inner.style.setProperty("--day-w", TL.dayW + "px"); // for the CSS gradient grid
  inner.style.setProperty("--name-w", TL.nameW + "px"); // sticky task column width

  // header (day scale: months on the top row, day numbers below)
  const header = document.createElement("div");
  header.className = "tl-header";
  header.style.height = TL.headerH + "px";
  const corner = document.createElement("div");
  corner.className = "tl-corner";
  corner.textContent = tr("tl.corner");
  header.appendChild(corner);
  const scale = document.createElement("div");
  scale.className = "tl-scale";
  const monthsRow = document.createElement("div");
  monthsRow.className = "tl-months";
  let mi = 0;
  while (mi < totalDays) { // group by month, split segments at month boundaries
    const d0 = addDays(rangeStart, mi);
    const mKey = d0.getFullYear() * 100 + d0.getMonth();
    let mj = mi;
    while (mj < totalDays) {
      const d1 = addDays(rangeStart, mj);
      if (d1.getFullYear() * 100 + d1.getMonth() !== mKey) break;
      mj++;
    }
    const mEl = document.createElement("div");
    mEl.className = "tl-month";
    mEl.style.width = (mj - mi) * TL.dayW + "px";
    mEl.textContent = monthLabel(d0.getFullYear(), d0.getMonth());
    monthsRow.appendChild(mEl);
    mi = mj;
  }
  scale.appendChild(monthsRow);
  const daysRow = document.createElement("div");
  daysRow.className = "tl-days";
  for (let k = 0; k < totalDays; k++) {
    const d = addDays(rangeStart, k);
    const el = document.createElement("div");
    el.className = "tl-day" + (d.getDay() === 0 || d.getDay() === 6 ? " weekend" : "");
    el.style.width = TL.dayW + "px";
    el.textContent = d.getDate();
    el.title = fmtDate(d);
    daysRow.appendChild(el);
  }
  scale.appendChild(daysRow);
  header.appendChild(scale);
  inner.appendChild(header);

  // rows + record bar coordinates (for dependency arrows)
  const barPos = new Map(); // id -> {x1, x2, y}
  let y = TL.headerH;
  const rowEls = [];
  for (const sec of state.sections) {
    // subtasks nest under a dated parent; a subtask whose parent is missing/undated renders as a normal row
    const secTasks = topoSortTasks(sectionTasks(sec).filter(t => bars.has(t.id) && (!t.parent_id || !bars.has(t.parent_id))));
    const secRow = document.createElement("div");
    secRow.className = "tl-row tl-section-row";
    secRow.style.height = TL.secRowH + "px";
    secRow.innerHTML = `<div class="tl-name">${esc(sec)}</div><div class="tl-track"></div>`;
    attachTrackCreate(secRow.querySelector(".tl-track"), sec, rangeStart);
    inner.appendChild(secRow);
    y += TL.secRowH;

    // expanded parents are followed by their dated subtask rows; collapsed parents hide them
    // (hidden rows never get a bar position, so dependency arrows to/from them are skipped automatically)
    const rowsToRender = [];
    for (const t of secTasks) {
      rowsToRender.push({ t, isSub: false });
      if (!t.parent_id && !isCollapsed(t.id)) {
        for (const c of topoSortTasks(childrenOf(t.id).filter(x => bars.has(x.id)))) rowsToRender.push({ t: c, isSub: true });
      }
    }
    for (const { t, isSub } of rowsToRender) {
      const b = bars.get(t.id);
      const row = document.createElement("div");
      row.className = "tl-row";
      row.style.height = TL.rowH + "px";
      const nameEl = document.createElement("div");
      nameEl.className = "tl-name" + (t.completed ? " task-done" : "") + (isSub ? " sub" : "");
      nameEl.title = t.name;
      if (isSub) {
        const ind = document.createElement("span");
        ind.className = "sub-indent";
        nameEl.appendChild(ind);
      } else if (hasChildren(t.id)) {
        const tog = document.createElement("button");
        tog.type = "button";
        tog.className = "sub-toggle";
        const collapsed = isCollapsed(t.id);
        tog.textContent = collapsed ? "▸" : "▾";
        tog.title = collapsed ? tr("sub.expand") : tr("sub.collapse");
        tog.addEventListener("click", e => {
          e.stopPropagation();
          setCollapsed(t.id, !collapsed);
          render();
        });
        nameEl.appendChild(tog);
      } else {
        const sp = document.createElement("span");
        sp.className = "sub-toggle sub-toggle-spacer";
        nameEl.appendChild(sp);
      }
      const nm = document.createElement("span");
      nm.className = "tl-name-text";
      nm.textContent = t.name;
      nameEl.appendChild(nm);
      nameEl.addEventListener("click", () => openDetail(t.id));
      row.appendChild(nameEl);

      const track = document.createElement("div");
      track.className = "tl-track";
      track.style.width = trackW + "px";
      attachTrackCreate(track, sec, rangeStart);
      // day/week grid lines and weekend shading are drawn by .tl-track's CSS gradients (rangeStart aligned to Monday, period 7 days)
      const bar = document.createElement("div");
      bar.className = "tl-bar" + (t.completed ? " done" : "");
      bar.dataset.taskId = t.id; // for multi-select highlight / batch drag positioning
      if (state.tlSelected.has(t.id)) bar.classList.add("tl-bar-selected"); // keep the selected state across re-renders
      if (b.inferred) bar.style.opacity = "0.75";
      // bars are colored by Category (same catColor mapping as the calendar):
      // open = solid theme color; completed = light tint of the theme color (keeps the greyed-out done feel, no conflict with inferred opacity);
      // no Category keeps the default blue/green style
      if (t.category) {
        const cc = catColor(t.category);
        if (t.completed) {
          bar.style.background = tintHex(cc, 0.65);
          bar.style.borderColor = tintHex(cc, 0.4);
        } else {
          bar.style.background = cc;
          bar.style.borderColor = cc;
        }
      }
      // tooltip shows real data only: show the range only when start exists, otherwise just the due date
      const sF = fmtDate(b.start), dF = fmtDate(b.due);
      bar.title = t.name + "\n" + (t.start_on ? (sF === dF ? sF : `${sF} → ${dF}`) : tr("tl.dueOnly", { date: dF }));
      positionBar(bar, b, xOf);
      bar.innerHTML = '<span class="tl-resize l"></span><span class="tl-resize r"></span>';
      // task name labels always sit outside the bar on the right (full dark text, not truncated);
      // fall back to outside-left (right-aligned) when there is not enough room near the chart's right edge
      const label = document.createElement("span");
      label.textContent = t.name;
      label.className = "tl-bar-label";
      const textW = tlLabelWidth(t.name);
      const barRightX = xOf(b.due) + TL.dayW;
      label.classList.add(barRightX + 8 + textW <= trackW ? "out-r" : "out-l");
      bar.appendChild(label);
      // parent bars: collapse/expand caret on the bar itself (same state as the label-column triangle);
      // narrow bars get the caret just outside the left edge; its events never reach drag/resize/multi-select
      if (!isSub && hasChildren(t.id)) {
        const barW = xOf(b.due) + TL.dayW - xOf(b.start);
        const caret = document.createElement("span");
        caret.className = "tl-bar-caret" + (barW < (isMobile ? 56 : 44) ? " outside" : "");
        const collapsed = isCollapsed(t.id);
        caret.textContent = collapsed ? "▸" : "▾";
        caret.title = collapsed ? tr("sub.expand") : tr("sub.collapse");
        caret.addEventListener("pointerdown", e => e.stopPropagation());
        caret.addEventListener("click", e => {
          e.stopPropagation();
          setCollapsed(t.id, !collapsed);
          render();
        });
        bar.appendChild(caret);
      }
      attachBarDrag(bar, t, b, xOf);
      track.appendChild(bar);
      row.appendChild(track);
      inner.appendChild(row);
      barPos.set(t.id, { x1: xOf(b.start), x2: xOf(b.due) + TL.dayW, y: y + TL.rowH / 2 });
      y += TL.rowH;
      rowEls.push(row);
    }
  }

  // today line
  const td = today();
  if (td >= rangeStart && td <= rangeEnd) {
    const line = document.createElement("div");
    line.className = "tl-today";
    line.style.left = (TL.nameW + xOf(td)) + "px";
    line.style.top = TL.headerH + "px";
    line.style.height = (y - TL.headerH) + "px";
    inner.appendChild(line);
  }

  // dependency arrows (explicit sizes, avoiding percentage-height collapse)
  inner.appendChild(buildDepArrows(barPos, TL.nameW + trackW, y));

  const skipped = state.tasks.length - dated.length;
  if (skipped > 0) {
    const hint = document.createElement("div");
    hint.className = "tl-empty-hint";
    hint.textContent = tr("tl.skipped", { n: skipped });
    hint.style.position = "sticky";
    hint.style.left = "0";
    inner.appendChild(hint);
  }

  // clicking blank areas outside bars: clear multi-selection
  wrap.addEventListener("click", e => { if (!e.target.closest(".tl-bar")) clearTLSelect(); });

  wrap.appendChild(inner);
  container.appendChild(wrap);
}

/* Canvas-based measurement of .tl-bar-label text width: works even for elements not yet in the tree
   (renderTimeline builds off-screen DOM). Used to decide whether there is enough room for the label
   outside the bar's right edge (falls back to the left side when not).
   Font sizes stay in sync with CSS: desktop 11px / mobile 10px; font family taken from body's computed style. */
let _tlLabelCtx = null;
function tlLabelWidth(text) {
  if (!_tlLabelCtx) _tlLabelCtx = document.createElement("canvas").getContext("2d");
  const size = window.matchMedia("(max-width: 768px)").matches ? 10 : 11;
  _tlLabelCtx.font = size + "px " + getComputedStyle(document.body).fontFamily;
  return _tlLabelCtx.measureText(text).width;
}

function positionBar(bar, b, xOf) {
  bar.style.left = xOf(b.start) + "px";
  bar.style.width = (diffDays(b.start, b.due) + 1) * TL.dayW - 2 + "px";
}

/* timeline multi-select: Shift/Cmd/Ctrl+click toggles selection; blank click / Esc clears (wired up in init and renderTimeline) */
function toggleTLSelect(id) {
  if (state.tlSelected.has(id)) state.tlSelected.delete(id);
  else state.tlSelected.add(id);
  $$(".tl-bar[data-task-id]").forEach(b => b.classList.toggle("tl-bar-selected", state.tlSelected.has(b.dataset.taskId)));
}
function clearTLSelect() {
  if (!state.tlSelected.size) return;
  state.tlSelected.clear();
  $$(".tl-bar.tl-bar-selected").forEach(b => b.classList.remove("tl-bar-selected"));
}

function attachBarDrag(bar, task, b, xOf) {
  let mode = null, startX = 0, origStart = null, origDue = null, batch = [];

  // enter drag state: called immediately on mouse pointerdown; on touch after a 300ms long-press (anchored at the finger position on activation, preventing bar jumps)
  function startDrag(e, anchorX) {
    startX = anchorX;
    origStart = new Date(b.start);
    origDue = new Date(b.due);
    bar.dataset.moved = "0";
    bar.classList.add(mode === "move" ? "dragging" : "resizing");
    try { bar.setPointerCapture(e.pointerId); } catch (_) {}

    // desktop multi-select batch: when a selected bar is dragged, the other selected bars follow live by the same number of days (resize is not batched; no multi-select on touch)
    batch = [];
    if (e.pointerType !== "touch" && mode === "move" && state.tlSelected.size > 1 && state.tlSelected.has(task.id)) {
      const barEls = {};
      $$(".tl-bar[data-task-id]").forEach(el => { barEls[el.dataset.taskId] = el; });
      for (const id of state.tlSelected) {
        if (id === task.id) continue;
        const bt = taskById(id), bEl = barEls[id];
        if (!bt || !bEl) continue;
        const bs = parseDate(bt.start_on) || parseDate(bt.due_on); // single-day bar without start: treat start as due
        const bd = parseDate(bt.due_on) || parseDate(bt.start_on);
        if (!bs || !bd) continue;
        batch.push({ id, bar: bEl, s: bs, d: bd, hadStart: !!bt.start_on });
        bEl.classList.add("dragging");
      }
    }

    function onMove(ev) {
      const delta = Math.round((ev.clientX - startX) / TL.dayW);
      if (delta !== 0) bar.dataset.moved = "1";
      let ns = new Date(origStart), nd = new Date(origDue);
      if (mode === "move") { ns = addDays(origStart, delta); nd = addDays(origDue, delta); }
      else if (mode === "left") { ns = addDays(origStart, delta); if (ns > nd) ns = new Date(nd); }
      else { nd = addDays(origDue, delta); if (nd < ns) nd = new Date(ns); }
      positionBar(bar, { start: ns, due: nd }, xOf);
      bar.dataset.ns = fmtDate(ns);
      bar.dataset.nd = fmtDate(nd);
      for (const it of batch) positionBar(it.bar, { start: addDays(it.s, delta), due: addDays(it.d, delta) }, xOf);
    }
    async function onUp() {
      bar.removeEventListener("pointermove", onMove);
      bar.removeEventListener("pointerup", onUp);
      bar.removeEventListener("pointercancel", onUp);
      bar.classList.remove("dragging", "resizing", "tl-bar-armed");
      for (const it of batch) it.bar.classList.remove("dragging");
      document.removeEventListener("touchmove", _lockScroll);
      if (e.pointerType === "touch") suppressClickUntil = Date.now() + 350;
      const ns = bar.dataset.ns, nd = bar.dataset.nd;
      const changed = ns && nd && (ns !== fmtDate(b.start) || nd !== fmtDate(b.due));
      if (changed) {
        const delta = diffDays(b.due, parseDate(nd)); // shift in days of the dragged bar; followers offset by the same amount
        const jobs = [];
        if (!task.start_on && mode === "move") {
          // single-day bar without start_on: whole-bar moves only change due_on, never fabricate a start_on
          jobs.push([task.id, { due_on: nd }]);
        } else {
          // edge drags (l/r) "pull out" a start_on; only then is start_on written
          jobs.push([task.id, { start_on: ns, due_on: nd }]);
        }
        for (const it of batch) {
          const ns2 = fmtDate(addDays(it.s, delta)), nd2 = fmtDate(addDays(it.d, delta));
          jobs.push(it.hadStart ? [it.id, { start_on: ns2, due_on: nd2 }] : [it.id, { due_on: nd2 }]);
        }
        // silent PUTs one by one, single re-render after all complete (render preserves scroll position internally)
        for (const [id, patch] of jobs) await updateTask(id, patch, { silent: true });
        render();
      } else {
        positionBar(bar, b, xOf);
        for (const it of batch) positionBar(it.bar, { start: it.s, due: it.d }, xOf);
      }
      batch = [];
    }
    bar.addEventListener("pointermove", onMove);
    bar.addEventListener("pointerup", onUp);
    bar.addEventListener("pointercancel", onUp);
  }

  // Pointer Events: mouse and touch paths diverge (.tl-bar allows touch-action: pan-x pan-y on touch)
  bar.addEventListener("pointerdown", e => {
    if (e.button > 0) return;
    e.stopPropagation();
    if (e.target.classList.contains("l")) mode = "left";
    else if (e.target.classList.contains("r")) mode = "right";
    else mode = "move";

    if (e.pointerType !== "touch") {
      e.preventDefault();
      startDrag(e, e.clientX); // desktop mouse: original logic, drag immediately
      return;
    }

    // touch: drag only after a 300ms long-press; swiping on a bar without a long-press = normal scrolling (no interference)
    const downX = e.clientX, downY = e.clientY;
    let lastX = downX, fired = false;
    const timer = setTimeout(() => {
      if (fired) return;
      fired = true;
      detach();
      bar.classList.add("tl-bar-armed");
      if (navigator.vibrate) try { navigator.vibrate(10); } catch (_) {}
      document.addEventListener("touchmove", _lockScroll, { passive: false }); // scroll lock only after activation
      startDrag(e, lastX);
    }, 300);

    function onEarlyMove(ev) {
      lastX = ev.clientX;
      if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 10) abort(); // fast swipe = scroll/swipe
    }
    function onEarlyEnd() { abort(); }
    function abort() {
      if (fired) return;
      fired = true;
      clearTimeout(timer);
      detach();
    }
    function detach() {
      bar.removeEventListener("pointermove", onEarlyMove);
      bar.removeEventListener("pointerup", onEarlyEnd);
      bar.removeEventListener("pointercancel", onEarlyEnd);
    }
    bar.addEventListener("pointermove", onEarlyMove);
    bar.addEventListener("pointerup", onEarlyEnd);
    bar.addEventListener("pointercancel", onEarlyEnd);
  });
  // click: not treated as a click after dragging; Shift/Cmd/Ctrl+click toggles multi-select; plain click clears selection and opens details
  bar.addEventListener("click", e => {
    if (bar.dataset.moved === "1") { bar.dataset.moved = "0"; return; }
    if (clickSuppressed()) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey) { toggleTLSelect(task.id); return; }
    if (state.tlSelected.size) clearTLSelect();
    openDetail(task.id);
  });
}

/*
 * Dependency links: orthogonal routing (horizontal/vertical segments only, zero diagonals) + large rounded arc bends (Asana-style soft polylines).
 * Predecessor right-edge midpoint -> small exit arc (r<=4: the arc completes within +-4px of the row midpoint, the vertical
 *   segment runs in the +4px channel, never touching the task-name label that starts at +7 from the predecessor's right edge)
 *   -> vertical down to the clear band in the row gap below the predecessor row
 *   -> large arc (target 18px, shrunk to fit adjacent lengths) turning into the row gap -> horizontal travel
 *   -> large arc turning vertical -> vertical into the successor row -> large arc hooking into the successor's left-edge midpoint (arrowhead orient:auto follows).
 * The whole path uses only L/A commands; every bend is a quarter arc with radius = min(18, adjacent-edge allowance), shrinking near adjacent rows but staying round.
 * Successor above (cross-section): symmetric mirror; successor to the left (overlapping dates): the row-gap segment goes left, same shape.
 * Same row: shallow U dip of 11px (when the horizontal gap <24px, sink to 17px below the row bottom, passing under both bars); straight line as last resort.
 */
function elbowPathD(x1, y1, x2, y2) {
  const dx = x2 - x1;
  if (y1 === y2) return sameRowBumpD(x1, y1, x2, dx);
  const sy = y2 > y1 ? 1 : -1;            // vertical direction: down +1 / up -1
  const d = dx >= 0 ? 1 : -1;             // horizontal direction within the row gap
  const gapY = y1 + sy * TL.rowH / 2;     // predecessor row boundary (centerline of the row-gap clear band)
  const v1 = TL.rowH / 2;                 // total drop of the exit vertical segment (down to the row gap)
  const v2 = Math.abs(y2 - gapY);         // total drop of the vertical segment into the successor
  const hg = Math.abs(dx);                // total horizontal distance available in the row gap
  const r1 = Math.min(4, v1 / 2);         // exit bend: 4px label-safety cap
  const r2 = Math.max(0, Math.min(18, v1 - r1, (hg - r1) / 2));
  const r3 = Math.max(0, Math.min(18, v2 / 2, (hg - r1 - r2) / 2));
  const r4 = Math.max(0, Math.min(18, v2 - r3, hg - r1 - r2 - r3));
  const swV = sy > 0 ? 1 : 0;             // east -> south/north
  const swIn = (-sy * d) > 0 ? 1 : 0;     // south/north -> east/west (same shape entering the row gap & hooking into the successor)
  const swOut = (sy * d) > 0 ? 1 : 0;     // east/west -> south/north (leaving the row gap)
  return [
    `M ${x1} ${y1}`,
    `A ${r1} ${r1} 0 0 ${swV} ${x1 + r1} ${y1 + sy * r1}`,        // exit bend (small arc, avoids the label)
    `L ${x1 + r1} ${gapY - sy * r2}`,
    `A ${r2} ${r2} 0 0 ${swIn} ${x1 + r1 + d * r2} ${gapY}`,      // turn into the row gap (large arc)
    `L ${x2 - d * (r3 + r4)} ${gapY}`,
    `A ${r3} ${r3} 0 0 ${swOut} ${x2 - d * r4} ${gapY + sy * r3}`, // leave the row gap (large arc)
    `L ${x2 - d * r4} ${y2 - sy * r4}`,
    `A ${r4} ${r4} 0 0 ${swIn} ${x2} ${y2}`,                       // hook into the successor's left edge (large arc, horizontal end tangent)
  ].join(" ");
}

/* U-shaped shallow dip for same-row dependencies: bend down off the predecessor's right edge -> horizontal along the clear band under the row -> bend up into the successor's left edge; four arcs, no diagonals */
function sameRowBumpD(x1, y1, x2, dx) {
  if (dx <= 0) return `M ${x1} ${y1} L ${x2} ${y1}`; // theoretically impossible; straight line as fallback
  const dip = dx < 24 ? TL.rowH / 2 : 11; // tiny gap: sink to 17px below the row (under both bars); otherwise a shallow 11px dip
  const by = y1 + dip;
  const r1 = Math.min(4, dip / 2);         // entry/exit bends: bar-hugging safety cap
  const r2 = Math.max(0, Math.min(18, dip - r1, (dx - 2 * r1) / 2)); // the two large bottom arcs
  return [
    `M ${x1} ${y1}`,
    `A ${r1} ${r1} 0 0 1 ${x1 + r1} ${y1 + r1}`,     // E→S
    `L ${x1 + r1} ${by - r2}`,
    `A ${r2} ${r2} 0 0 0 ${x1 + r1 + r2} ${by}`,     // S->E (large arc)
    `L ${x2 - r1 - r2} ${by}`,
    `A ${r2} ${r2} 0 0 0 ${x2 - r1} ${by - r2}`,     // E->N (large arc)
    `L ${x2 - r1} ${y1 + r1}`,
    `A ${r1} ${r1} 0 0 1 ${x2} ${y1}`,               // N→E
  ].join(" ");
}

function buildDepArrows(barPos, totalW, totalH) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = "tl-svg";
  svg.setAttribute("width", totalW);
  svg.setAttribute("height", totalH);
  svg.style.width = totalW + "px";
  svg.style.height = totalH + "px";

  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
  marker.setAttribute("id", "arrowhead");
  marker.setAttribute("markerWidth", "8");
  marker.setAttribute("markerHeight", "8");
  marker.setAttribute("refX", "7");
  marker.setAttribute("refY", "3");
  marker.setAttribute("orient", "auto");
  const tri = document.createElementNS("http://www.w3.org/2000/svg", "path");
  tri.setAttribute("d", "M0,0 L7,3 L0,6 Z");
  tri.setAttribute("fill", "#a08f8f");
  marker.appendChild(tri);
  defs.appendChild(marker);
  svg.appendChild(defs);

  for (const t of state.tasks) {
    const to = barPos.get(t.id);
    if (!to) continue;
    for (const depId of t.dependencies || []) {
      const from = barPos.get(depId);
      if (!from) continue;
      const x1 = TL.nameW + from.x2 + 2, y1 = from.y;
      const x2 = TL.nameW + to.x1 - 3, y2 = to.y;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", elbowPathD(x1, y1, x2, y2));
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "#a08f8f");
      path.setAttribute("stroke-width", "1.5");
      path.setAttribute("marker-end", "url(#arrowhead)");
      svg.appendChild(path);
    }
  }
  return svg;
}

/* ================= calendar view ================= */
/* Unified handling of calendar drop targets: tasks with start_on shift start+due as a whole by (drop date - grabbed segment date) days;
   single-day tasks without start_on only change due_on (same behavior as the old version). */
function moveCalTask(t, fromDate, toDate) {
  if (!toDate || toDate === fromDate) return;
  if (!t.due_on) {
    // tasks with start_on but no due_on (normally not shown in the calendar; dragged in from outside): due becomes whichever cell they land on
    updateTask(t.id, { due_on: toDate });
    return;
  }
  if (t.start_on) {
    const delta = diffDays(parseDate(fromDate), parseDate(toDate));
    if (!delta) return;
    updateTask(t.id, {
      start_on: fmtDate(addDays(parseDate(t.start_on), delta)),
      due_on: fmtDate(addDays(parseDate(t.due_on), delta)),
    });
  } else {
    updateTask(t.id, { due_on: toDate });
  }
}

function renderCalendar(container) {
  if (state.calYear == null) {
    const t = today();
    state.calYear = t.getFullYear();
    state.calMonth = t.getMonth();
  }
  const head = document.createElement("div");
  head.id = "calendar-header";
  head.innerHTML = `
    <button data-nav="-1">${tr("cal.prev")}</button>
    <button data-nav="today">${tr("cal.today")}</button>
    <button data-nav="1">${tr("cal.next")}</button>
    <h2>${monthLabel(state.calYear, state.calMonth)}</h2>`;
  head.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
    const nav = b.dataset.nav;
    if (nav === "today") { const t = today(); state.calYear = t.getFullYear(); state.calMonth = t.getMonth(); }
    else {
      state.calMonth += Number(nav);
      if (state.calMonth < 0) { state.calMonth = 11; state.calYear--; }
      if (state.calMonth > 11) { state.calMonth = 0; state.calYear++; }
    }
    render();
  }));
  container.appendChild(head);

  const grid = document.createElement("div");
  grid.className = "cal-grid";
  for (const d of weekdayLabels()) {
    const el = document.createElement("div");
    el.className = "cal-dow";
    el.textContent = d;
    grid.appendChild(el);
  }

  const first = new Date(state.calYear, state.calMonth, 1);
  const startOffset = (first.getDay() + 6) % 7; // week starts on Monday
  const gridStart = addDays(first, -startOffset);
  // multi-day tasks (start_on and start<due): one segment lands on each day from start to due,
  // segments in adjacent cells are joined by CSS into a continuous bar (split and rejoined at week boundaries, like Google Calendar)
  const byDate = new Map(); // dateKey -> [{task, seg}]; seg: null=single-day entry | {first,last}=multi-day segment
  for (const t of state.tasks) {
    if (!t.due_on) continue;
    if (t.start_on && t.start_on < t.due_on) {
      for (let day = parseDate(t.start_on); day <= parseDate(t.due_on); day = addDays(day, 1)) {
        const k = fmtDate(day);
        if (!byDate.has(k)) byDate.set(k, []);
        byDate.get(k).push({ task: t, seg: { first: k === t.start_on, last: k === t.due_on } });
      }
    } else {
      // only due_on, or start_on == due_on: single-day entry, behavior unchanged
      if (!byDate.has(t.due_on)) byDate.set(t.due_on, []);
      byDate.get(t.due_on).push({ task: t, seg: null });
    }
  }

  const td = today();
  const isMobile = window.matchMedia("(max-width: 768px)").matches;
  const CAL_ITEM_LIMIT = isMobile ? 2 : Infinity; // mobile shows at most 2 items per cell + a "+N more" link
  for (let i = 0; i < 42; i++) {
    const day = addDays(gridStart, i);
    const key = fmtDate(day);
    const cell = document.createElement("div");
    cell.className = "cal-cell";
    cell.dataset.date = key; // used as the touch-drag drop target
    if (day.getMonth() !== state.calMonth) cell.classList.add("other-month");
    if (fmtDate(day) === fmtDate(td)) cell.classList.add("today");
    const num = document.createElement("span");
    num.className = "cal-day-num";
    num.textContent = day.getDate();
    cell.appendChild(num);

    const dayEntries = (byDate.get(key) || []).sort((a, b) => {
      if (!!a.seg !== !!b.seg) return a.seg ? -1 : 1; // multi-day segments sort before single-day entries
      return a.task.order - b.task.order;
    });
    const col = i % 7; // 0=Mon ... 6=Sun; must split and rejoin at week boundaries
    const makeItem = entry => {
      const t = entry.task;
      const item = document.createElement("div");
      item.className = "cal-item" + (t.completed ? " task-done" : "");
      if (entry.seg) {
        // multi-day segments: adjoining ends within a week row lose their rounding and bridge the cell gap with negative margins (ext-l/ext-r);
        // the task name repeats on the first segment and on each week's first segment; other segments keep row height as placeholders
        const roundL = entry.seg.first || col === 0;
        const roundR = entry.seg.last || col === 6;
        item.classList.add("cal-span", roundL ? "sp-l" : "ext-l", roundR ? "sp-r" : "ext-r");
        item.textContent = roundL ? t.name : " ";
        item.title = `${t.name}\n${t.start_on} → ${t.due_on}` + (t.assignee ? " · " + t.assignee : "");
      } else {
        item.textContent = t.name;
        item.title = t.name + (t.assignee ? " · " + t.assignee : "");
      }
      // the whole block is colored by Category (consistent with board .pill: solid theme color + white text); multi-day segments are colored the same
      if (t.category) {
        item.classList.add("cal-cat");
        item.style.background = catColor(t.category);
      }
      item.draggable = true;
      item.addEventListener("click", () => { if (!clickSuppressed()) openDetail(t.id); });
      item.addEventListener("dragstart", e => {
        e.dataTransfer.setData("text/task-id", t.id);
        e.dataTransfer.setData("text/cal-grab-date", key); // remember which segment was grabbed; the drop shifts the whole task by the day difference
        e.dataTransfer.effectAllowed = "move";
      });
      // touch: long-press 400ms, then drag to another date cell (movement >15px during the wait cancels as scroll)
      attachTouchDrag(item, {
        pressDelay: 400,
        cancelThreshold: 15,
        makeGhost: () => {
          const g = item.cloneNode(true);
          g.style.width = Math.max(80, item.offsetWidth) + "px";
          return g;
        },
        onMove: (x, y) => {
          $$(".cal-cell.drag-over").forEach(c => c.classList.remove("drag-over"));
          const hit = document.elementFromPoint(x, y);
          const c = hit && hit.closest(".cal-cell");
          if (c) c.classList.add("drag-over");
        },
        onDrop: (x, y) => {
          const hit = document.elementFromPoint(x, y);
          const c = hit && hit.closest(".cal-cell");
          if (c && c.dataset.date && c.dataset.date !== key) {
            moveCalTask(t, key, c.dataset.date);
          }
        },
        onEnd: () => $$(".cal-cell.drag-over").forEach(c => c.classList.remove("drag-over")),
      });
      return item;
    };
    dayEntries.slice(0, CAL_ITEM_LIMIT).forEach(en => cell.appendChild(makeItem(en)));
    if (dayEntries.length > CAL_ITEM_LIMIT) {
      const more = document.createElement("div");
      more.className = "cal-more";
      more.textContent = tr("cal.more", { n: dayEntries.length - CAL_ITEM_LIMIT });
      more.addEventListener("click", () => {
        dayEntries.slice(CAL_ITEM_LIMIT).forEach(en => cell.insertBefore(makeItem(en), more));
        more.remove();
      });
      cell.appendChild(more);
    }

    cell.addEventListener("dragover", e => { e.preventDefault(); cell.classList.add("drag-over"); });
    cell.addEventListener("dragleave", () => cell.classList.remove("drag-over"));
    cell.addEventListener("drop", e => {
      e.preventDefault();
      cell.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/task-id");
      if (!id) return;
      const t = taskById(id);
      const grab = e.dataTransfer.getData("text/cal-grab-date");
      if (t) moveCalTask(t, grab || t.due_on || key, key);
    });
    grid.appendChild(cell);
  }
  container.appendChild(grid);
}

/* ================= detail panel ================= */
function openDetail(id) {
  state.detailId = id;
  renderDetail();
  $("#detail-panel").classList.remove("hidden");
}
function closeDetail() {
  state.detailId = null;
  $("#detail-panel").classList.add("hidden");
}

function detailRow(labelText, inputEl) {
  const row = document.createElement("div");
  row.className = "detail-row";
  const label = document.createElement("label");
  label.textContent = labelText;
  row.appendChild(label);
  row.appendChild(inputEl);
  return row;
}
function textInput(value, onCommit, opts) {
  opts = opts || {};
  const inp = document.createElement(opts.textarea ? "textarea" : "input");
  if (!opts.textarea) inp.type = opts.type || "text";
  inp.value = value || "";
  if (opts.list) inp.setAttribute("list", opts.list);
  if (opts.placeholder) inp.placeholder = opts.placeholder;
  inp.addEventListener("change", () => {
    const v = inp.value.trim();
    if (v !== (value || "")) onCommit(v);
  });
  return inp;
}

function renderDetail() {
  const t = taskById(state.detailId);
  if (!t) return closeDetail();
  const body = $("#detail-body");
  body.innerHTML = "";

  // title row: checkbox + name
  const titleRow = document.createElement("div");
  titleRow.className = "detail-title-row";
  titleRow.appendChild(makeCheckbox(t));
  const nameInp = textInput(t.name, v => updateTask(t.id, { name: v || t.name }));
  titleRow.appendChild(nameInp);
  body.appendChild(titleRow);

  body.appendChild(detailRow(tr("field.section"), (() => {
    const sel = document.createElement("select");
    for (const s of state.sections) {
      const o = document.createElement("option");
      o.value = s; o.textContent = s;
      if (s === t.section) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => moveTask(t.id, sel.value, sectionTasks(sel.value).length));
    return sel;
  })()));

  // parent task (one-level subtasks): candidates = top-level tasks excluding self;
  // a task that already has subtasks cannot gain a parent (select disabled, with hint)
  const kids = childrenOf(t.id);
  body.appendChild(detailRow(tr("field.parent"), (() => {
    const wrap = document.createElement("div");
    wrap.className = "detail-parent";
    const sel = document.createElement("select");
    const none = document.createElement("option");
    none.value = "";
    none.textContent = tr("select.none");
    sel.appendChild(none);
    for (const sec2 of state.sections) {
      for (const o of topTasks(sec2)) {
        if (o.id === t.id) continue;
        const opt = document.createElement("option");
        opt.value = o.id;
        opt.textContent = o.name + " (" + o.section + ")";
        sel.appendChild(opt);
      }
    }
    sel.value = t.parent_id || "";
    sel.disabled = kids.length > 0;
    sel.addEventListener("change", () => {
      const np = sel.value || null;
      if (np) {
        const p = taskById(np);
        placeTask(t.id, { section: p ? p.section : t.section, parentId: np, index: childrenOf(np).length });
      } else {
        placeTask(t.id, { section: t.section, parentId: null, index: topTasks(t.section).filter(x => x.id !== t.id).length });
      }
    });
    wrap.appendChild(sel);
    if (kids.length) {
      const hint = document.createElement("div");
      hint.className = "parent-hint";
      hint.textContent = tr("field.parentLocked");
      wrap.appendChild(hint);
    } else if (t.parent_id) {
      const un = document.createElement("button");
      un.type = "button";
      un.className = "parent-unlink";
      un.textContent = "✕";
      un.title = tr("sub.unparent");
      un.addEventListener("click", () => {
        placeTask(t.id, { section: t.section, parentId: null, index: topTasks(t.section).filter(x => x.id !== t.id).length });
      });
      wrap.appendChild(un);
    }
    return wrap;
  })()));

  body.appendChild(detailRow(tr("field.assignee"), textInput(t.assignee, v => updateTask(t.id, { assignee: v }), { list: "dl-assignees" })));
  // dates: iOS auto-fills today on the first tap of an empty date input; pre-fill on pointerdown to avoid "first tap commits and closes"
  const startInp = textInput(t.start_on || "", v => updateTask(t.id, { start_on: v || null }), { type: "date" });
  const dueInp = textInput(t.due_on || "", v => updateTask(t.id, { due_on: v || null }), { type: "date" });
  fixIOSDateInput(startInp);
  fixIOSDateInput(dueInp);
  body.appendChild(detailRow(tr("field.start"), startInp));
  body.appendChild(detailRow(tr("field.due"), dueInp));
  // Category / Effort / Priority: select + custom (datalist unusable on iOS)
  body.appendChild(detailRow("Category", makeSelectOrCustom({ field: "category", value: t.category, onCommit: v => updateTask(t.id, { category: v }) })));
  body.appendChild(detailRow("Effort", makeSelectOrCustom({ field: "effort", value: t.effort, onCommit: v => updateTask(t.id, { effort: v }) })));
  body.appendChild(detailRow("Priority", makeSelectOrCustom({ field: "priority", value: t.priority, onCommit: v => updateTask(t.id, { priority: v }) })));

  // dependencies (multi-select)
  const depBox = document.createElement("div");
  depBox.className = "dep-list";
  const depSet = new Set(t.dependencies || []);
  for (const other of state.tasks.filter(o => o.id !== t.id).sort((a, b) => a.section.localeCompare(b.section) || a.order - b.order)) {
    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = depSet.has(other.id);
    cb.addEventListener("change", () => {
      const deps = new Set(t.dependencies || []);
      if (cb.checked) deps.add(other.id); else deps.delete(other.id);
      updateTask(t.id, { dependencies: [...deps] });
    });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(" " + tr("deps.entry", { name: other.name, section: other.section })));
    depBox.appendChild(lab);
  }
  body.appendChild(detailRow(tr("field.deps"), depBox));

  body.appendChild(detailRow(tr("field.notes"), textInput(t.notes, v => updateTask(t.id, { notes: v }), { textarea: true })));

  const actions = document.createElement("div");
  actions.className = "detail-actions";
  if (!t.parent_id) {
    const addSub = document.createElement("button");
    addSub.type = "button";
    addSub.className = "add-subtask-btn";
    addSub.textContent = tr("task.addSubtask");
    addSub.addEventListener("click", () => openTaskDialog({ section: t.section, parent_id: t.id }));
    actions.appendChild(addSub);
  }
  const del = document.createElement("button");
  del.className = "btn-danger";
  del.textContent = tr("task.delete");
  del.addEventListener("click", () => {
    confirmDialog(tr("confirm.deleteTask", { name: t.name }), () => {
      deleteTask(t.id).catch(err => showToast(tr("toast.deleteFailed", { msg: err.message }), true));
    });
  });
  actions.appendChild(del);
  if (t.link) {
    const a = document.createElement("a");
    a.className = "detail-link";
    a.href = t.link;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = tr("task.openInAsana");
    actions.appendChild(a);
  }
  body.appendChild(actions);
}

/* ================= init ================= */
function showLogin(msg) {
  const ov = $("#login-overlay");
  ov.classList.remove("hidden");
  if (msg) $("#login-error").textContent = msg;
  setTimeout(() => $("#login-token").focus(), 0);
}
function hideLogin() {
  $("#login-overlay").classList.add("hidden");
  $("#login-error").textContent = "";
  $("#login-token").value = "";
}

function init() {
  // ?token= brought in by the login page redirect: store in localStorage and clean the address bar
  const urlTok = new URLSearchParams(location.search).get("token");
  if (urlTok) {
    setToken(urlTok);
    history.replaceState(null, "", location.pathname);
  }

  $$(".tab").forEach(b => b.addEventListener("click", () => {
    state.view = b.dataset.view;
    render();
  }));
  // language switcher (sidebar bottom): switch + initial translation of static strings
  $$("#lang-switch button").forEach(b => b.addEventListener("click", () => setLang(b.dataset.lang)));
  applyI18n();
  updateLangSwitch();
  // the "＋ 分组" button becomes an inline creator (replaces prompt)
  $("#btn-new-section").replaceWith(makeInlineCreator({
    buttonLabelKey: "btn.newSection",
    buttonClass: "creator-btn-bordered",
    placeholderKey: "section.namePh",
    onSubmit: name => addSection(name),
  }));
  // sidebar "＋ 新建项目" inline creator
  projectCreatorEl = makeInlineCreator({
    buttonLabelKey: "btn.newProject",
    buttonClass: "creator-btn-sidebar",
    placeholderKey: "project.namePh",
    onSubmit: name => createProject(name),
  });
  $("#btn-new-project").replaceWith(projectCreatorEl);
  $("#detail-close").addEventListener("click", closeDetail);
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    clearTLSelect(); // timeline multi-select: Esc clears
    if (state.detailId) closeDetail();
  });

  // mobile drawer menu
  const sidebar = $("#sidebar"), backdrop = $("#sidebar-backdrop");
  function closeMenu() { sidebar.classList.remove("open"); backdrop.classList.add("hidden"); }
  $("#btn-menu").addEventListener("click", () => {
    sidebar.classList.add("open");
    backdrop.classList.remove("hidden");
  });
  $("#btn-menu-close").addEventListener("click", closeMenu);
  backdrop.addEventListener("click", closeMenu);
  $$("#sidebar .nav-item").forEach(n => n.addEventListener("click", closeMenu));

  // logout: clear the token and go back to / (the server will return the login page)
  $("#btn-logout").addEventListener("click", () => {
    clearToken();
    location.href = "/";
  });

  // login overlay submit: save the token and try loading data
  $("#login-form").addEventListener("submit", async e => {
    e.preventDefault();
    const t = $("#login-token").value.trim();
    if (!t) return;
    setToken(t);
    try {
      await boot();
      hideLogin();
      render();
    } catch (err) {
      showLogin(err.message === "unauthorized" ? tr("login.badToken") : tr("app.loadFailed", { msg: err.message }));
    }
  });

  if (!getToken()) {
    // no token: try unauthenticated access first (--no-auth mode lets you straight in); show the login overlay on 401
    boot().then(render).catch(e => {
      if (e.message !== "unauthorized") {
        $("#view-container").innerHTML = `<div class="tl-empty-hint">${esc(tr("app.loadFailed", { msg: e.message }))}</div>`;
      }
    });
    return;
  }
  boot().then(render).catch(e => {
    if (e.message !== "unauthorized") {
      $("#view-container").innerHTML = `<div class="tl-empty-hint">${esc(tr("app.loadFailed", { msg: e.message }))}</div>`;
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
