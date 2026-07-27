/* mini-asana 前端 SPA — 原生 JS，无外部依赖 */
"use strict";

/* ================= 状态 ================= */
const state = {
  tasks: [],
  sections: [],
  view: "list",
  calYear: null,
  calMonth: null, // 0-based
  detailId: null,
  tlSelected: new Set(), // 时间线多选横条（Shift/Cmd/Ctrl+click），用于批量平移
  projectId: null,       // 当前项目 id
  projects: [],          // 全部项目 [{id,name,task_count}]
  legacy: false,         // 服务端无项目 API（旧版）时退回单项目模式
};

/* ================= 工具 ================= */
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
/* #rrggbb 向白色混合 f（0=原色，1=白）：已完成色块用的浅色 tint */
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

/* ================= 触屏拖拽（Pointer Events，iOS Safari 可用） ================= */
/* 桌面端仍走 HTML5 DnD；本模块只在 pointerType === "touch" 时介入。
   双条件触发模型，防误触：
     阶段0（等待）：pressDelay 长按计时；期间位移 > cancelThreshold(15px) 视为滚动/轻扫，取消。
     阶段1（armed）：长按成功 → 震动 + 高亮描边反馈，但还不出影子。
     阶段2（拖拽）：armed 后位移 > dragThreshold(10px) 才真正进入拖拽
                    （跟随影子 + 非 passive touchmove preventDefault 锁滚动）。
   轻点（未达长按、位移小）不触发任何拖拽视觉，click 正常放行。 */
let suppressClickUntil = 0; // 拖拽结束后短暂抑制 click，避免误开详情
function clickSuppressed() { return Date.now() < suppressClickUntil; }

function _lockScroll(e) { e.preventDefault(); }

function attachTouchDrag(el, opts) {
  const pressDelay = opts.pressDelay != null ? opts.pressDelay : 400;
  const cancelTh = opts.cancelThreshold || 15; // 等待期内多大幅度算滚动取消
  const dragTh = opts.dragThreshold || 10;     // armed 后多大幅度开始真拖
  el.addEventListener("pointerdown", e => {
    if (e.pointerType !== "touch" || e.button > 0) return;
    const startX = e.clientX, startY = e.clientY;
    let phase = 0, ghost = null; // 0=等待长按 1=armed 2=拖拽中
    try { el.setPointerCapture(e.pointerId); } catch (_) {} // 仅追踪，不影响滚动
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
        if (dist > cancelTh) { clearTimeout(timer); cleanup(); } // 快速划过 = 滚动/轻点
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
    function onCancel() { cleanup(); } // 浏览器接管滚动时触发
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

/* ================= 通用 UI 组件（替代原生 prompt/confirm/alert） ================= */
/* toast 轻提示（替代 alert） */
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

/* 内联确认对话框（替代 confirm）：message + 取消/确认 */
function confirmDialog(message, onOk) {
  const ov = document.createElement("div");
  ov.className = "confirm-overlay";
  ov.innerHTML = `<div class="confirm-card">
    <p class="confirm-msg">${esc(message)}</p>
    <div class="confirm-btns">
      <button type="button" class="btn-cancel">取消</button>
      <button type="button" class="btn-danger btn-ok">确认</button>
    </div></div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector(".btn-cancel").addEventListener("click", close);
  ov.addEventListener("click", e => { if (e.target === ov) close(); });
  ov.querySelector(".btn-ok").addEventListener("click", () => { close(); onOk(); });
  ov.querySelector(".btn-ok").focus();
}

/*
 * 内联创建器（替代 prompt）：「＋ 按钮」→ 点击变「输入框 + ✓ 确认」。
 * - 回车 / 点 ✓ 提交（等价）；Esc 取消恢复按钮
 * - blur：内容为空才恢复按钮，非空保留（手机用户可能只是收起了键盘）
 * - 提交中禁用输入和按钮防重复提交；失败 toast 提示并恢复可编辑
 */
function makeInlineCreator(opts) {
  const wrap = document.createElement("div");
  wrap.className = "inline-creator";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "add-task-btn" + (opts.buttonClass ? " " + opts.buttonClass : "");
  btn.textContent = opts.buttonLabel;
  wrap.appendChild(btn);

  btn.addEventListener("click", () => {
    const form = document.createElement("div");
    form.className = "inline-creator-form";
    const inp = document.createElement("input");
    inp.className = "inline-input";
    inp.placeholder = opts.placeholder || "";
    inp.setAttribute("enterkeyhint", "done");
    inp.setAttribute("autocomplete", "off");
    inp.setAttribute("autocorrect", "off");
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "inline-creator-ok";
    ok.textContent = "✓";
    ok.title = "确认";
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
        showToast("创建失败: " + e.message, true);
        submitting = false;
        inp.disabled = false;
        ok.disabled = false;
        inp.focus();
        return;
      }
      revert(); // 成功后恢复为按钮（列表/看板随后整体重渲染，此处无害）
    }
    inp.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") revert();
    });
    ok.addEventListener("click", submit);
    inp.addEventListener("blur", () => {
      // 延迟判断：点 ✓ 会先触发 blur，此时 submitting 已为 true 则不恢复
      setTimeout(() => { if (!closed && !submitting && !inp.value.trim()) revert(); }, 120);
    });
  });
  return wrap;
}

/* ================= 字段 select 组件（datalist 在 iOS Safari 不可用，统一替换） ================= */
const CUSTOM_OPT = "__custom__";

/* 各字段的候选值：Category 取项目已有值；Effort 预置 小/中/大 + 已有值；Priority 固定 高/中/低 */
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
  empty.textContent = "无";
  sel.appendChild(empty);
  for (const v of vals) {
    const o = document.createElement("option");
    o.value = v; o.textContent = v;
    sel.appendChild(o);
  }
  const c = document.createElement("option");
  c.value = CUSTOM_OPT;
  c.textContent = "自定义…";
  sel.appendChild(c);
  sel.value = current || "";
}

/* 提交式 select：用于详情面板和列表内联编辑，选定即 onCommit；选「自定义…」换成文本输入 */
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
    inp.placeholder = "输入新值，回车确认";
    inp.setAttribute("autocomplete", "off");
    inp.setAttribute("autocorrect", "off");
    sel.replaceWith(inp);
    inp.focus();
    let done = false;
    const finish = v => { if (!done) { done = true; opts.onCommit(v); } };
    inp.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); finish(inp.value.trim()); }
      else if (e.key === "Escape") { done = true; render(); } // 放弃，恢复 select
    });
    inp.addEventListener("blur", () => setTimeout(() => finish(inp.value.trim()), 100));
  });
  wrap.appendChild(sel);
  return wrap;
}

/* 取值式 select：用于创建对话框，提交时经 wrap.getValue() 取最终值 */
function makeDialogSelect(field) {
  const wrap = document.createElement("span");
  wrap.className = "sel-custom sel-custom-dialog";
  const sel = document.createElement("select");
  fillSelectOptions(sel, field, "");
  const inp = document.createElement("input");
  inp.type = "text";
  inp.className = "sel-custom-input";
  inp.placeholder = "输入新值";
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

/* iOS 空日期框首次点击会自动提交今天并收起选择器：
   触屏设备上 pointerdown 时若为空先填今天，选择器直接以今天为起点弹出，可正常滚动修改 */
function fixIOSDateInput(inp) {
  if (!window.matchMedia("(pointer: coarse)").matches) return;
  inp.addEventListener("pointerdown", () => { if (!inp.value) inp.value = fmtDate(today()); });
}

/*
 * 新建任务对话框（替代内联输入，一次填好所有字段）。
 * prefill: { section?, start_on?, due_on? } —— 列表/看板传 section；时间线空白点击另传日期。
 * 名称必填（空时禁用创建按钮）；回车=创建（输入法组合中除外）；Esc/遮罩/✕/取消关闭。
 */
function openTaskDialog(prefill) {
  prefill = prefill || {};
  const ov = document.createElement("div");
  ov.className = "task-dialog-overlay";
  ov.innerHTML = `
  <div class="task-dialog" role="dialog" aria-label="新建任务">
    <div class="td-header"><span>新建任务</span><button type="button" class="td-close" title="关闭">✕</button></div>
    <div class="td-body">
      <label>任务名称 *</label>
      <input class="td-name" type="text" placeholder="要做什么？" enterkeyhint="done" autocomplete="off" autocorrect="off">
      <label>分组</label>
      <select class="td-section"></select>
      <label>负责人</label>
      <input class="td-assignee" type="text" list="dl-assignees" autocomplete="off" placeholder="负责人">
      <div class="td-row">
        <div><label>开始日期</label><input class="td-start" type="date"></div>
        <div><label>截止日期</label><input class="td-due" type="date"></div>
      </div>
      <label>Category</label>
      <div class="td-slot" data-f="category"></div>
      <div class="td-row">
        <div><label>Effort</label><div class="td-slot" data-f="effort"></div></div>
        <div><label>Priority</label><div class="td-slot" data-f="priority"></div></div>
      </div>
    </div>
    <div class="td-footer">
      <button type="button" class="td-cancel">取消</button>
      <button type="button" class="td-submit" disabled>创建</button>
    </div>
  </div>`;
  document.body.appendChild(ov);

  const $q = sel => ov.querySelector(sel);
  const nameInp = $q(".td-name"), sel = $q(".td-section");
  const submitBtn = $q(".td-submit"), cancelBtn = $q(".td-cancel");
  for (const s of state.sections) {
    const o = document.createElement("option");
    o.value = s; o.textContent = s;
    sel.appendChild(o);
  }
  sel.value = prefill.section && state.sections.includes(prefill.section) ? prefill.section : state.sections[0];
  // Category / Effort / Priority：select + 自定义（iOS datalist 不可用）
  const catF = makeDialogSelect("category");
  const effF = makeDialogSelect("effort");
  const priF = makeDialogSelect("priority");
  $q('[data-f="category"]').replaceWith(catF);
  $q('[data-f="effort"]').replaceWith(effF);
  $q('[data-f="priority"]').replaceWith(priF);
  // iOS 空日期框首点会自动提交今天并收起，统一预填今天（时间线点击创建会覆盖为所点日期）
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
        assignee: $q(".td-assignee").value.trim(),
        start_on: $q(".td-start").value || null,
        due_on: $q(".td-due").value || null,
        category: catF.getValue(),
        effort: effF.getValue(),
        priority: priF.getValue(),
      });
      close();
    } catch (e) {
      showToast("创建失败: " + e.message, true);
      busy = false;
      submitBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  }
  submitBtn.addEventListener("click", submit);
  ov.querySelectorAll("input").forEach(inp => inp.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.isComposing && inp.type !== "date") { e.preventDefault(); submit(); }
  }));
  // 仅桌面端自动聚焦名称输入框（移动端避免弹出键盘干扰日期等字段操作）
  if (!window.matchMedia("(max-width: 768px)").matches) {
    setTimeout(() => nameInp.focus(), 0);
  }
}

/* ================= API ================= */
/* token 认证：token 存 localStorage，所有请求自动带 Authorization: Bearer 头。
   收到 401 时清除 token 并显示登录遮罩。--no-auth 模式下无 token 也能正常访问。 */
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
/* ---------- 项目 ---------- */
const PROJECT_KEY = "mini_asana_project";
/* 项目作用域 API：/api/projects/<pid><path>；旧版服务端（无项目 API）退回 /api<path> */
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
    // 旧版服务端没有项目 API：退回单项目模式（任务走 /api/tasks 等旧路径）
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
    showToast("加载项目失败: " + e.message, true);
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
  confirmDialog(`删除项目「${p.name}」？其中的任务会一并删除，不可恢复。`, async () => {
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
      showToast("删除项目失败: " + e.message, true);
    }
  });
}

/* 侧边栏项目列表：点击切换，hover 显示 ✎ 重命名 / 🗑 删除（仅剩一个项目时不显示 🗑） */
function renderProjects() {
  const box = $("#project-list");
  if (!box) return;
  if (box.querySelector(".project-rename-form")) return; // 重命名输入中不重建
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
    ren.title = "重命名项目";
    ren.addEventListener("click", e => { e.stopPropagation(); startProjectRename(p, name); });
    acts.appendChild(ren);
    if (state.projects.length > 1) {
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "🗑";
      del.title = "删除项目";
      del.addEventListener("click", e => { e.stopPropagation(); removeProject(p); });
      acts.appendChild(del);
    }
    item.appendChild(acts);
    item.addEventListener("click", () => {
      switchProject(p.id);
      // 移动端：点击项目后收起抽屉
      $("#sidebar").classList.remove("open");
      $("#sidebar-backdrop").classList.add("hidden");
    });
    box.appendChild(item);
  }
}

/* 项目重命名：把名称就地换成输入框 + ✓（同分组重命名模式） */
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
      renderStats(); // 顶栏标题随项目名更新
    } catch (e) {
      showToast("重命名失败: " + e.message, true);
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
/* 启动流程：先取项目列表（决定 projectId），再加载该项目任务 */
async function boot() {
  await loadProjects();
  await loadAll();
}
let projectCreatorEl = null; // 「＋ 新建项目」内联创建器（init 时挂载）

async function updateTask(id, patch, opts) {
  const t = taskById(id);
  if (t) Object.assign(t, patch);
  try {
    const saved = await papi("PUT", "/tasks/" + encodeURIComponent(id), patch);
    if (t) Object.assign(t, saved);
  } catch (e) {
    showToast("保存失败: " + e.message, true);
    await loadAll();
  }
  if (!opts || !opts.silent) render(); // silent：批量提交时跳过，由调用方最后统一 render
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
  state.tasks = state.tasks.filter(t => t.id !== id);
  if (state.detailId === id) closeDetail();
  render();
}
async function moveTask(taskId, targetSection, targetIndex) {
  const t = taskById(taskId);
  if (!t) return;
  const srcSection = t.section;
  // 乐观更新
  const siblings = sectionTasks(targetSection).filter(x => x.id !== taskId);
  t.section = targetSection;
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
    showToast("移动失败: " + e.message, true);
    await loadAll();
    render();
  }
}
async function addSection(name) {
  await papi("POST", "/sections", { name });
  state.sections.push(name);
  render();
}
/* 分组重命名：把 h3 标题就地换成输入框 + ✓（替代 prompt） */
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
      showToast("重命名失败: " + e.message, true);
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
  confirmDialog(`删除分组「${name}」？其中的任务会移到第一个分组。`, async () => {
    try {
      const r = await papi("DELETE", "/sections/" + encodeURIComponent(name));
      state.sections = r.sections;
      state.tasks.forEach(t => { if (t.section === name) t.section = r.moved_to; });
      render();
    } catch (e) {
      showToast("删除分组失败: " + e.message, true);
    }
  });
}

/* ================= 渲染入口 ================= */
function render() {
  renderStats();
  renderProjects();
  renderDatalists();
  $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.view === state.view));
  const c = $("#view-container");
  // 重渲染前保存滚动位置（视图容器 + 时间线/看板自带滚动层），渲染完成后恢复，避免拖动提交后跳动/丢失位置
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
  if (ap) $("#project-title").textContent = ap.name; // 顶栏标题 = 当前项目名
  const open = state.tasks.filter(t => !t.completed).length;
  const done = state.tasks.length - open;
  if (window.matchMedia("(max-width: 768px)").matches) {
    $("#stats").innerHTML = `<b>${open}</b> 未完成`;
  } else {
    $("#stats").innerHTML = `<b>${open}</b> 个未完成任务 · ${done} 已完成`;
  }
}

function renderDatalists() {
  const assignees = [...new Set(state.tasks.map(t => t.assignee).filter(Boolean))];
  $("#dl-assignees").innerHTML = assignees.map(a => `<option value="${esc(a)}">`).join("");
}

/* 内联编辑：点击字段变输入框 */
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
  b.title = task.completed ? "标记为未完成" : "标记为完成";
  b.addEventListener("click", e => {
    e.stopPropagation();
    updateTask(task.id, { completed: !task.completed });
  });
  return b;
}

/* ================= 列表视图 ================= */
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
        <button data-act="rename" title="重命名分组">✎</button>
        <button data-act="delete" title="删除分组">🗑</button>
      </span>`;
    header.querySelector('[data-act="rename"]').addEventListener("click", () => startSectionRename(sec, header.querySelector("h3")));
    header.querySelector('[data-act="delete"]').addEventListener("click", () => removeSection(sec));
    // 拖到 section 标题 = 移到该 section 末尾
    header.addEventListener("dragover", e => { e.preventDefault(); });
    header.addEventListener("drop", e => {
      e.preventDefault();
      const id = e.dataTransfer.getData("text/task-id");
      if (id) moveTask(id, sec, sectionTasks(sec).filter(t => t.id !== id).length);
    });
    secEl.appendChild(header);

    for (const task of tasks) {
      secEl.appendChild(makeListRow(task, sec));
    }

    // 添加任务：弹出表单对话框，一次填好字段
    const addTaskBtn = document.createElement("button");
    addTaskBtn.className = "add-task-btn";
    addTaskBtn.textContent = "＋ 添加任务";
    addTaskBtn.addEventListener("click", () => openTaskDialog({ section: sec }));
    secEl.appendChild(addTaskBtn);
    // 拖到空白区 = 移到末尾（行/标题的 drop 已 stopPropagation）
    secEl.addEventListener("dragover", e => e.preventDefault());
    secEl.addEventListener("drop", e => {
      e.preventDefault();
      const id = e.dataTransfer.getData("text/task-id");
      if (id) moveTask(id, sec, sectionTasks(sec).filter(t => t.id !== id).length);
    });
    container.appendChild(secEl);
  }
}

/* 列表触屏拖拽辅助：清除落点高亮 / 命中检测（行 → before/after；section → 末尾） */
function clearListDropMarks() {
  $$(".list-row.drop-before, .list-row.drop-after").forEach(r => r.classList.remove("drop-before", "drop-after"));
}
function listDropTarget(x, y, selfRow) {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  const row = hit.closest(".list-row");
  if (row && row !== selfRow) {
    const secEl = row.closest(".list-section");
    if (!secEl) return null;
    const r = row.getBoundingClientRect();
    return { row, section: secEl.dataset.section, before: y < r.top + r.height / 2 };
  }
  const secEl = hit.closest(".list-section");
  if (secEl) return { row: null, section: secEl.dataset.section };
  return null;
}

function makeListRow(task, sec) {
  const row = document.createElement("div");
  row.className = "list-row" + (task.completed ? " task-done" : "");
  row.dataset.taskId = task.id;

  const handle = document.createElement("span");
  handle.className = "drag-handle";
  handle.textContent = "⠿";
  handle.draggable = true;
  handle.title = "拖拽排序 / 移动分组";
  handle.addEventListener("dragstart", e => {
    e.dataTransfer.setData("text/task-id", task.id);
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setDragImage(row, 20, 12); } catch (_) {}
    row.classList.add("dragging");
  });
  handle.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    clearListDropMarks();
  });
  // 触屏：按住手柄 180ms 进入拖拽（handle 已设 touch-action:none，无滚动冲突）
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
      const t = listDropTarget(x, y, row);
      if (t && t.row) t.row.classList.add(t.before ? "drop-before" : "drop-after");
    },
    onDrop: (x, y) => {
      const t = listDropTarget(x, y, row);
      if (!t) return;
      const list = sectionTasks(t.section).filter(x => x.id !== task.id);
      let idx = list.length;
      if (t.row) {
        idx = list.findIndex(x => x.id === t.row.dataset.taskId);
        if (idx < 0) idx = list.length;
        else if (!t.before) idx += 1;
      }
      moveTask(task.id, t.section, idx);
    },
    onEnd: clearListDropMarks,
  });
  row.appendChild(handle);

  row.appendChild(makeCheckbox(task));

  // 任务名：单击打开详情面板（改名在详情面板进行；与看板/时间线/日历行为一致）
  const nameCell = document.createElement("div");
  nameCell.className = "task-name";
  const nameView = document.createElement("span");
  nameView.textContent = task.name;
  nameView.style.cursor = "pointer";
  nameView.title = "点击打开详情";
  nameView.addEventListener("click", e => {
    e.stopPropagation();
    if (!clickSuppressed()) openDetail(task.id);
  });
  nameCell.appendChild(nameView);
  row.appendChild(nameCell);

  // 负责人
  row.appendChild(makeCell(task, "assignee", { list: "dl-assignees", placeholder: "负责人" }));
  // 截止日期
  row.appendChild(makeCell(task, "due_on", { type: "date", cls: "cell-date" }));
  // Category / Effort / Priority（点击后为 select + 自定义）
  row.appendChild(makeCell(task, "category", { pill: true }));
  row.appendChild(makeCell(task, "effort", { placeholder: "工作量" }));
  row.appendChild(makeCell(task, "priority", { pri: true }));

  const del = document.createElement("button");
  del.className = "del-btn";
  del.textContent = "✕";
  del.title = "删除任务";
  del.addEventListener("click", e => {
    e.stopPropagation();
    confirmDialog(`删除任务「${task.name}」？`, () => {
      deleteTask(task.id).catch(err => showToast("删除失败: " + err.message, true));
    });
  });
  row.appendChild(del);

  // 行内非交互空白区（名字单元格 padding、行本体）点击 → 打开详情；
  // 勾选框/字段内联编辑/手柄/删除按钮的点击 target 是各自元素，不会命中此分支
  row.addEventListener("click", e => {
    if (e.target !== row && e.target !== nameCell) return;
    if (!clickSuppressed()) openDetail(task.id);
  });

  // 放置目标
  row.addEventListener("dragover", e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = row.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    row.classList.toggle("drop-before", before);
    row.classList.toggle("drop-after", !before);
    row.dataset.dropPos = before ? "before" : "after";
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"));
  row.addEventListener("drop", e => {
    e.preventDefault();
    e.stopPropagation();
    const id = e.dataTransfer.getData("text/task-id");
    row.classList.remove("drop-before", "drop-after");
    if (!id || id === task.id) return;
    const list = sectionTasks(sec).filter(t => t.id !== id);
    let idx = list.findIndex(t => t.id === task.id);
    if (row.dataset.dropPos === "after") idx += 1;
    moveTask(id, sec, idx);
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
    view.title = "点击编辑";
    view.addEventListener("click", () => {
      // Category / Effort / Priority 用 select+自定义（datalist 在 iOS 不可用）
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

/* ================= 看板视图 ================= */
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
        <button data-act="rename" title="重命名列">✎</button>
        <button data-act="delete" title="删除列">🗑</button>
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

    // 添加任务：弹出表单对话框（替代内联输入）
    const addTaskBtn = document.createElement("button");
    addTaskBtn.className = "add-task-btn";
    addTaskBtn.textContent = "＋ 添加任务";
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
  // 触屏：长按 400ms 进入拖拽（等待期移动 >15px 视为滚动取消，激活后移 10px 才真拖），跨列/列内落位
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

/* 看板触屏拖拽辅助 */
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

/* ================= 时间线视图 ================= */
const TL = { dayW: 30, nameW: 220, headerH: 34, rowH: 34, secRowH: 30 };

/*
 * 时间线行排序：组内 Kahn 拓扑排序。
 * - 仅考虑本组（已过滤为有日期任务）内部的依赖边；跨 section 依赖不参与排序。
 * - ready 集中每次取「截止日期最早，其次当前 order」的任务，保证结果稳定且同链任务逐层相邻。
 * - 检测到环时，环内任务按原相对顺序追加，不丢任务、不死循环。
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
  if (out.length < tasks.length) { // 有环：剩余任务保持原相对顺序追加
    const placed = new Set(out.map(t => t.id));
    for (const t of tasks) if (!placed.has(t.id)) out.push(t);
  }
  return out;
}


/*
 * 时间线空白区点击/拖选创建任务。
 * - 点击空白（非横条）：弹出创建对话框，分组=所在行 section，开始=截止=点击处日期
 * - 鼠标按住横向拖动 >5px：拖选日期范围（虚线框视觉反馈），开始=起点、截止=终点
 * - 触屏保持滚动优先，只用 tap（click）触发单日创建；横条上的交互不受影响
 */
function attachTrackCreate(track, sec, rangeStart) {
  const dateAtX = px => addDays(rangeStart, Math.max(0, Math.floor(px / TL.dayW)));
  let mouseHandledAt = 0;

  track.addEventListener("pointerdown", e => {
    if (e.pointerType === "touch") return; // 触屏走 click（tap），不干扰滚动
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
    if (Date.now() - mouseHandledAt < 400) return; // 鼠标路径已在 pointerup 处理
    if (e.target.closest(".tl-bar")) return;       // 点在横条上 = 打开详情，不创建
    if (clickSuppressed()) return;                 // 拖拽刚结束的合成 click
    const rect = track.getBoundingClientRect();
    const d = dateAtX(e.clientX - rect.left);
    openTaskDialog({ section: sec, start_on: fmtDate(d), due_on: fmtDate(d) });
  });
}

function renderTimeline(container) {
  const wrap = document.createElement("div");
  wrap.id = "timeline";

  // 移动端：天列宽 30→20px，sticky 任务列 220→110px（所有坐标换算都基于这两个值）
  const isMobile = window.matchMedia("(max-width: 768px)").matches;
  TL.dayW = isMobile ? 20 : 30;
  TL.nameW = isMobile ? 110 : 220;

  // 计算日期范围
  const dated = state.tasks.filter(t => t.start_on || t.due_on);
  if (!dated.length) {
    wrap.innerHTML = '<div class="tl-empty-hint">没有带日期的任务。在任务详情中设置开始/截止日期后会显示在这里。</div>';
    container.appendChild(wrap);
    return;
  }
  let minD = null, maxD = null;
  const bars = new Map(); // id -> {start, due}
  for (const t of dated) {
    let s = parseDate(t.start_on), d = parseDate(t.due_on);
    if (!s && d) s = new Date(d);          // 无开始日期：只画截止日单日横条，不推断长度（避免伪造数据）
    if (!d && s) d = new Date(s);          // 无截止日期：单日
    if (d < s) d = new Date(s);
    bars.set(t.id, { start: s, due: d, inferred: !t.start_on || !t.due_on });
    if (!minD || s < minD) minD = s;
    if (!maxD || d > maxD) maxD = d;
  }
  // 对齐到周一 + buffer
  let rangeStart = addDays(minD, -7);
  rangeStart = addDays(rangeStart, -((rangeStart.getDay() + 6) % 7)); // 对齐周一
  const rangeEnd = addDays(maxD, 14);
  const totalDays = diffDays(rangeStart, rangeEnd) + 1;
  const trackW = totalDays * TL.dayW;

  const xOf = d => diffDays(rangeStart, d) * TL.dayW;

  const inner = document.createElement("div");
  inner.className = "tl-inner";
  inner.style.width = (TL.nameW + trackW) + "px";
  inner.style.setProperty("--day-w", TL.dayW + "px"); // 供 CSS 渐变网格使用
  inner.style.setProperty("--name-w", TL.nameW + "px"); // sticky 任务列宽

  // 表头（按天刻度：上排月份、下排日号）
  const header = document.createElement("div");
  header.className = "tl-header";
  header.style.height = TL.headerH + "px";
  const corner = document.createElement("div");
  corner.className = "tl-corner";
  corner.textContent = "任务 / 日期";
  header.appendChild(corner);
  const scale = document.createElement("div");
  scale.className = "tl-scale";
  const monthsRow = document.createElement("div");
  monthsRow.className = "tl-months";
  let mi = 0;
  while (mi < totalDays) { // 按月份分组，跨月分段
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
    mEl.textContent = `${d0.getFullYear()}年${d0.getMonth() + 1}月`;
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

  // 行 + 记录 bar 坐标（供依赖箭头）
  const barPos = new Map(); // id -> {x1, x2, y}
  let y = TL.headerH;
  const rowEls = [];
  for (const sec of state.sections) {
    const secTasks = topoSortTasks(sectionTasks(sec).filter(t => bars.has(t.id)));
    const secRow = document.createElement("div");
    secRow.className = "tl-row tl-section-row";
    secRow.style.height = TL.secRowH + "px";
    secRow.innerHTML = `<div class="tl-name">${esc(sec)}</div><div class="tl-track"></div>`;
    attachTrackCreate(secRow.querySelector(".tl-track"), sec, rangeStart);
    inner.appendChild(secRow);
    y += TL.secRowH;

    for (const t of secTasks) {
      const b = bars.get(t.id);
      const row = document.createElement("div");
      row.className = "tl-row";
      row.style.height = TL.rowH + "px";
      const nameEl = document.createElement("div");
      nameEl.className = "tl-name" + (t.completed ? " task-done" : "");
      nameEl.textContent = t.name;
      nameEl.title = t.name;
      nameEl.addEventListener("click", () => openDetail(t.id));
      row.appendChild(nameEl);

      const track = document.createElement("div");
      track.className = "tl-track";
      track.style.width = trackW + "px";
      attachTrackCreate(track, sec, rangeStart);
      // 天/周网格线与周末底色由 .tl-track 的 CSS 渐变绘制（rangeStart 对齐周一，周期 7 天）
      const bar = document.createElement("div");
      bar.className = "tl-bar" + (t.completed ? " done" : "");
      bar.dataset.taskId = t.id; // 供多选高亮/批量拖动定位
      if (state.tlSelected.has(t.id)) bar.classList.add("tl-bar-selected"); // 重渲染后保持选中态
      if (b.inferred) bar.style.opacity = "0.75";
      // 色块按 Category 着色（与日历同一套 catColor 映射）：
      // 未完成 = 实心主题色；已完成 = 主题色的浅色 tint（保留完成置灰感，与 inferred 的 opacity 不冲突）；
      // 无 Category 保持默认蓝/绿样式
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
      // tooltip 只显示真实数据：有 start 才显示区间，没有就只显示截止
      const sF = fmtDate(b.start), dF = fmtDate(b.due);
      bar.title = t.name + "\n" + (t.start_on ? (sF === dF ? sF : `${sF} → ${dF}`) : `截止 ${dF}`);
      positionBar(bar, b, xOf);
      bar.innerHTML = '<span class="tl-resize l"></span><span class="tl-resize r"></span>';
      // 任务名标签统一放色块右侧外部（深色完整显示，不截断）；
      // 右侧贴图表右缘空间不足时兜底放左侧外部（右对齐）
      const label = document.createElement("span");
      label.textContent = t.name;
      label.className = "tl-bar-label";
      const textW = tlLabelWidth(t.name);
      const barRightX = xOf(b.due) + TL.dayW;
      label.classList.add(barRightX + 8 + textW <= trackW ? "out-r" : "out-l");
      bar.appendChild(label);
      attachBarDrag(bar, t, b, xOf);
      track.appendChild(bar);
      row.appendChild(track);
      inner.appendChild(row);
      barPos.set(t.id, { x1: xOf(b.start), x2: xOf(b.due) + TL.dayW, y: y + TL.rowH / 2 });
      y += TL.rowH;
      rowEls.push(row);
    }
  }

  // 今天线
  const td = today();
  if (td >= rangeStart && td <= rangeEnd) {
    const line = document.createElement("div");
    line.className = "tl-today";
    line.style.left = (TL.nameW + xOf(td)) + "px";
    line.style.top = TL.headerH + "px";
    line.style.height = (y - TL.headerH) + "px";
    inner.appendChild(line);
  }

  // 依赖箭头（显式尺寸，避免百分比高度塌陷）
  inner.appendChild(buildDepArrows(barPos, TL.nameW + trackW, y));

  const skipped = state.tasks.length - dated.length;
  if (skipped > 0) {
    const hint = document.createElement("div");
    hint.className = "tl-empty-hint";
    hint.textContent = `（${skipped} 个没有日期的任务未在时间线中显示）`;
    hint.style.position = "sticky";
    hint.style.left = "0";
    inner.appendChild(hint);
  }

  // 点击横条以外的空白区域：清空多选
  wrap.addEventListener("click", e => { if (!e.target.closest(".tl-bar")) clearTLSelect(); });

  wrap.appendChild(inner);
  container.appendChild(wrap);
}

/* Canvas 量 .tl-bar-label 文本宽度：元素未挂树时也能用（renderTimeline 构建期是离屏 DOM）。
   用于判断标签放色块右侧外部时空间是否足够（不够则兜底放左侧）。
   字号与 CSS 同步：桌面 11px / 移动端 10px；字族取 body 计算样式。 */
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

/* 时间线多选：Shift/Cmd/Ctrl+click 切换选中；空白点击 / Esc 清空（在 init 与 renderTimeline 接线） */
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

  // 进入拖拽态：鼠标 pointerdown 立即调用；触屏长按 300ms 后调用（以激活时手指位置为锚，防横条跳动）
  function startDrag(e, anchorX) {
    startX = anchorX;
    origStart = new Date(b.start);
    origDue = new Date(b.due);
    bar.dataset.moved = "0";
    bar.classList.add(mode === "move" ? "dragging" : "resizing");
    try { bar.setPointerCapture(e.pointerId); } catch (_) {}

    // 桌面多选批量：拖动「已选中」的横条移动时，其余选中条按相同天数实时跟随（resize 不批量；触屏无多选）
    batch = [];
    if (e.pointerType !== "touch" && mode === "move" && state.tlSelected.size > 1 && state.tlSelected.has(task.id)) {
      const barEls = {};
      $$(".tl-bar[data-task-id]").forEach(el => { barEls[el.dataset.taskId] = el; });
      for (const id of state.tlSelected) {
        if (id === task.id) continue;
        const bt = taskById(id), bEl = barEls[id];
        if (!bt || !bEl) continue;
        const bs = parseDate(bt.start_on) || parseDate(bt.due_on); // 无 start 的单日条：start 视为 due
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
        const delta = diffDays(b.due, parseDate(nd)); // 被拖条的平移天数，跟随条按同量偏移
        const jobs = [];
        if (!task.start_on && mode === "move") {
          // 无 start_on 的单日条：整体移动只改 due_on，不借机伪造 start_on
          jobs.push([task.id, { due_on: nd }]);
        } else {
          // 边缘拖拽（l/r）会把 start_on「拉出来」，此时才写入 start_on
          jobs.push([task.id, { start_on: ns, due_on: nd }]);
        }
        for (const it of batch) {
          const ns2 = fmtDate(addDays(it.s, delta)), nd2 = fmtDate(addDays(it.d, delta));
          jobs.push(it.hadStart ? [it.id, { start_on: ns2, due_on: nd2 }] : [it.id, { due_on: nd2 }]);
        }
        // 逐个静默 PUT，全部完成后一次重渲染（render 内部会保持滚动位置）
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

  // Pointer Events：鼠标与触屏分流（.tl-bar 触屏已放开 touch-action: pan-x pan-y）
  bar.addEventListener("pointerdown", e => {
    if (e.button > 0) return;
    e.stopPropagation();
    if (e.target.classList.contains("l")) mode = "left";
    else if (e.target.classList.contains("r")) mode = "right";
    else mode = "move";

    if (e.pointerType !== "touch") {
      e.preventDefault();
      startDrag(e, e.clientX); // 桌面鼠标：原逻辑，立即拖
      return;
    }

    // 触屏：长按 300ms 才进入拖拽；未长按时在横条上滑动 = 正常滚动（不干预）
    const downX = e.clientX, downY = e.clientY;
    let lastX = downX, fired = false;
    const timer = setTimeout(() => {
      if (fired) return;
      fired = true;
      detach();
      bar.classList.add("tl-bar-armed");
      if (navigator.vibrate) try { navigator.vibrate(10); } catch (_) {}
      document.addEventListener("touchmove", _lockScroll, { passive: false }); // 激活后才锁滚动
      startDrag(e, lastX);
    }, 300);

    function onEarlyMove(ev) {
      lastX = ev.clientX;
      if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 10) abort(); // 快速划过 = 滚动/轻扫
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
  // 点击：拖动过不当点击；Shift/Cmd/Ctrl+click 切换多选；普通点击清空选择并打开详情
  bar.addEventListener("click", e => {
    if (bar.dataset.moved === "1") { bar.dataset.moved = "0"; return; }
    if (clickSuppressed()) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey) { toggleTLSelect(task.id); return; }
    if (state.tlSelected.size) clearTLSelect();
    openDetail(task.id);
  });
}

/*
 * 依赖连线：正交路由（只走水平/竖直段、零斜线）+ 大圆角弧形弯（仿 Asana 的柔和折线）。
 * 前置右缘中点 → 出口小弧（r≤4：弧在行中点 ±4px 内完成，竖直段走 +4px 通道，
 *   不碰前置右缘 +7 起的任务名标签）→ 竖直到前置行底的行间隙净空带
 *   → 大弧（目标 18px，按邻边长收敛）转入行间隙 → 水平通行
 *   → 大弧转竖直 → 竖直进后继行 → 大弧钩入后继左缘中点（箭头 orient:auto 跟随）。
 * 全路径只用 L/A 命令；每个弯都是 1/4 圆弧，半径 = min(18, 邻边余量)，贴邻行时自动变小但保持圆润。
 * 后继在上方（跨 section）对称镜像；后继在左（日期重叠）时行间隙段向左，形状相同。
 * 同行：U 形浅蘸 11px（水平间隙 <24px 时沉到行底 17px，从两条横条下方通行），兜底直连。
 */
function elbowPathD(x1, y1, x2, y2) {
  const dx = x2 - x1;
  if (y1 === y2) return sameRowBumpD(x1, y1, x2, dx);
  const sy = y2 > y1 ? 1 : -1;            // 竖直方向：下 +1 / 上 -1
  const d = dx >= 0 ? 1 : -1;             // 行间隙水平方向
  const gapY = y1 + sy * TL.rowH / 2;     // 前置行的行边界（行间隙净空带中线）
  const v1 = TL.rowH / 2;                 // 出口竖直段总落差（到行间隙）
  const v2 = Math.abs(y2 - gapY);         // 入后继竖直段总落差
  const hg = Math.abs(dx);                // 行间隙水平总可用距离
  const r1 = Math.min(4, v1 / 2);         // 出口弯：标签安全上限 4px
  const r2 = Math.max(0, Math.min(18, v1 - r1, (hg - r1) / 2));
  const r3 = Math.max(0, Math.min(18, v2 / 2, (hg - r1 - r2) / 2));
  const r4 = Math.max(0, Math.min(18, v2 - r3, hg - r1 - r2 - r3));
  const swV = sy > 0 ? 1 : 0;             // 东 → 南/北
  const swIn = (-sy * d) > 0 ? 1 : 0;     // 南/北 → 东/西（入行间隙 & 钩入后继同型）
  const swOut = (sy * d) > 0 ? 1 : 0;     // 东/西 → 南/北（出行间隙）
  return [
    `M ${x1} ${y1}`,
    `A ${r1} ${r1} 0 0 ${swV} ${x1 + r1} ${y1 + sy * r1}`,        // 出口弯（小弧，避标签）
    `L ${x1 + r1} ${gapY - sy * r2}`,
    `A ${r2} ${r2} 0 0 ${swIn} ${x1 + r1 + d * r2} ${gapY}`,      // 转入行间隙（大弧）
    `L ${x2 - d * (r3 + r4)} ${gapY}`,
    `A ${r3} ${r3} 0 0 ${swOut} ${x2 - d * r4} ${gapY + sy * r3}`, // 出行间隙（大弧）
    `L ${x2 - d * r4} ${y2 - sy * r4}`,
    `A ${r4} ${r4} 0 0 ${swIn} ${x2} ${y2}`,                       // 钩入后继左缘（大弧，末端切线水平）
  ].join(" ");
}

/* 同行依赖的 U 形浅蘸：出前置右缘下弯 → 行底净空带水平 → 上弯入后继左缘，四段圆弧无斜线 */
function sameRowBumpD(x1, y1, x2, dx) {
  if (dx <= 0) return `M ${x1} ${y1} L ${x2} ${y1}`; // 理论不存在，兜底直连
  const dip = dx < 24 ? TL.rowH / 2 : 11; // 间隙极小：沉到行底 17px（两横条之下）；否则浅蘸 11px
  const by = y1 + dip;
  const r1 = Math.min(4, dip / 2);         // 进出弯：贴条安全上限
  const r2 = Math.max(0, Math.min(18, dip - r1, (dx - 2 * r1) / 2)); // 底部两个大弧
  return [
    `M ${x1} ${y1}`,
    `A ${r1} ${r1} 0 0 1 ${x1 + r1} ${y1 + r1}`,     // E→S
    `L ${x1 + r1} ${by - r2}`,
    `A ${r2} ${r2} 0 0 0 ${x1 + r1 + r2} ${by}`,     // S→E（大弧）
    `L ${x2 - r1 - r2} ${by}`,
    `A ${r2} ${r2} 0 0 0 ${x2 - r1} ${by - r2}`,     // E→N（大弧）
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

/* ================= 日历视图 ================= */
/* 日历拖拽落点统一处理：有 start_on 的任务按「落点 − 抓取段日期」的天数整体平移 start+due；
   无 start_on 的单日任务只改 due_on（行为同旧版）。 */
function moveCalTask(t, fromDate, toDate) {
  if (!toDate || toDate === fromDate) return;
  if (!t.due_on) {
    // 只有 start_on 没有 due_on 的任务（日历里本不显示，从外部拖入时）：落到哪格 due 就是哪格
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
    <button data-nav="-1">← 上月</button>
    <button data-nav="today">今天</button>
    <button data-nav="1">下月 →</button>
    <h2>${state.calYear} 年 ${state.calMonth + 1} 月</h2>`;
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
  for (const d of ["一", "二", "三", "四", "五", "六", "日"]) {
    const el = document.createElement("div");
    el.className = "cal-dow";
    el.textContent = "周" + d;
    grid.appendChild(el);
  }

  const first = new Date(state.calYear, state.calMonth, 1);
  const startOffset = (first.getDay() + 6) % 7; // 周一起
  const gridStart = addDays(first, -startOffset);
  // 跨天任务（start_on 且 start<due）：开始日到截止日每天都落一个段，
  // 相邻格的段用 CSS 连成连续横条（跨周在周行内截断续接，像 Google Calendar）
  const byDate = new Map(); // dateKey -> [{task, seg}]；seg: null=单日条目 | {first,last}=跨天段
  for (const t of state.tasks) {
    if (!t.due_on) continue;
    if (t.start_on && t.start_on < t.due_on) {
      for (let day = parseDate(t.start_on); day <= parseDate(t.due_on); day = addDays(day, 1)) {
        const k = fmtDate(day);
        if (!byDate.has(k)) byDate.set(k, []);
        byDate.get(k).push({ task: t, seg: { first: k === t.start_on, last: k === t.due_on } });
      }
    } else {
      // 只有 due_on，或 start_on == due_on：单日条目，行为不变
      if (!byDate.has(t.due_on)) byDate.set(t.due_on, []);
      byDate.get(t.due_on).push({ task: t, seg: null });
    }
  }

  const td = today();
  const isMobile = window.matchMedia("(max-width: 768px)").matches;
  const CAL_ITEM_LIMIT = isMobile ? 2 : Infinity; // 移动端每格最多显示 2 条 + 「+N 更多」
  for (let i = 0; i < 42; i++) {
    const day = addDays(gridStart, i);
    const key = fmtDate(day);
    const cell = document.createElement("div");
    cell.className = "cal-cell";
    cell.dataset.date = key; // 供触屏拖拽落点使用
    if (day.getMonth() !== state.calMonth) cell.classList.add("other-month");
    if (fmtDate(day) === fmtDate(td)) cell.classList.add("today");
    const num = document.createElement("span");
    num.className = "cal-day-num";
    num.textContent = day.getDate();
    cell.appendChild(num);

    const dayEntries = (byDate.get(key) || []).sort((a, b) => {
      if (!!a.seg !== !!b.seg) return a.seg ? -1 : 1; // 跨天段排在单日条目前面
      return a.task.order - b.task.order;
    });
    const col = i % 7; // 0=周一 … 6=周日；跨周处必须截断续接
    const makeItem = entry => {
      const t = entry.task;
      const item = document.createElement("div");
      item.className = "cal-item" + (t.completed ? " task-done" : "");
      if (entry.seg) {
        // 跨天段：周行内相接处去圆角 + 负 margin 桥接格缝（ext-l/ext-r）；
        // 任务名在第一段及每周首段重复显示，其余段占位保持行高
        const roundL = entry.seg.first || col === 0;
        const roundR = entry.seg.last || col === 6;
        item.classList.add("cal-span", roundL ? "sp-l" : "ext-l", roundR ? "sp-r" : "ext-r");
        item.textContent = roundL ? t.name : " ";
        item.title = `${t.name}\n${t.start_on} → ${t.due_on}` + (t.assignee ? " · " + t.assignee : "");
      } else {
        item.textContent = t.name;
        item.title = t.name + (t.assignee ? " · " + t.assignee : "");
      }
      // 整个色块按 Category 着色（与看板 .pill 一致：实心主题色 + 白字）；跨天各段同样着色
      if (t.category) {
        item.classList.add("cal-cat");
        item.style.background = catColor(t.category);
      }
      item.draggable = true;
      item.addEventListener("click", () => { if (!clickSuppressed()) openDetail(t.id); });
      item.addEventListener("dragstart", e => {
        e.dataTransfer.setData("text/task-id", t.id);
        e.dataTransfer.setData("text/cal-grab-date", key); // 记录抓住的是哪一段，落点按相差天数整体平移
        e.dataTransfer.effectAllowed = "move";
      });
      // 触屏：长按 400ms 拖到其他日期格子（等待期移动 >15px 视为滚动取消）
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
      more.textContent = `+${dayEntries.length - CAL_ITEM_LIMIT} 更多`;
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

/* ================= 详情面板 ================= */
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

  // 标题行：勾选 + 名称
  const titleRow = document.createElement("div");
  titleRow.className = "detail-title-row";
  titleRow.appendChild(makeCheckbox(t));
  const nameInp = textInput(t.name, v => updateTask(t.id, { name: v || t.name }));
  titleRow.appendChild(nameInp);
  body.appendChild(titleRow);

  body.appendChild(detailRow("分组", (() => {
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

  body.appendChild(detailRow("负责人", textInput(t.assignee, v => updateTask(t.id, { assignee: v }), { list: "dl-assignees" })));
  // 日期：iOS 空日期框首点系统自动填今天，pointerdown 时先预填以避免「第一次点被提交并收起」
  const startInp = textInput(t.start_on || "", v => updateTask(t.id, { start_on: v || null }), { type: "date" });
  const dueInp = textInput(t.due_on || "", v => updateTask(t.id, { due_on: v || null }), { type: "date" });
  fixIOSDateInput(startInp);
  fixIOSDateInput(dueInp);
  body.appendChild(detailRow("开始日期", startInp));
  body.appendChild(detailRow("截止日期", dueInp));
  // Category / Effort / Priority：select + 自定义（datalist 在 iOS 不可用）
  body.appendChild(detailRow("Category", makeSelectOrCustom({ field: "category", value: t.category, onCommit: v => updateTask(t.id, { category: v }) })));
  body.appendChild(detailRow("Effort", makeSelectOrCustom({ field: "effort", value: t.effort, onCommit: v => updateTask(t.id, { effort: v }) })));
  body.appendChild(detailRow("Priority", makeSelectOrCustom({ field: "priority", value: t.priority, onCommit: v => updateTask(t.id, { priority: v }) })));

  // 前置依赖（多选）
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
    lab.appendChild(document.createTextNode(` ${other.name}（${other.section}）`));
    depBox.appendChild(lab);
  }
  body.appendChild(detailRow("前置依赖", depBox));

  body.appendChild(detailRow("备注", textInput(t.notes, v => updateTask(t.id, { notes: v }), { textarea: true })));

  const actions = document.createElement("div");
  actions.className = "detail-actions";
  const del = document.createElement("button");
  del.className = "btn-danger";
  del.textContent = "删除任务";
  del.addEventListener("click", () => {
    confirmDialog(`删除任务「${t.name}」？`, () => {
      deleteTask(t.id).catch(err => showToast("删除失败: " + err.message, true));
    });
  });
  actions.appendChild(del);
  if (t.link) {
    const a = document.createElement("a");
    a.className = "detail-link";
    a.href = t.link;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "在 Asana 中打开 ↗";
    actions.appendChild(a);
  }
  body.appendChild(actions);
}

/* ================= 初始化 ================= */
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
  // 登录页跳转带来的 ?token=：存入 localStorage 并清理地址栏
  const urlTok = new URLSearchParams(location.search).get("token");
  if (urlTok) {
    setToken(urlTok);
    history.replaceState(null, "", location.pathname);
  }

  $$(".tab").forEach(b => b.addEventListener("click", () => {
    state.view = b.dataset.view;
    render();
  }));
  // 「＋ 分组」改为内联创建器（替代 prompt）
  $("#btn-new-section").replaceWith(makeInlineCreator({
    buttonLabel: "＋ 分组",
    buttonClass: "creator-btn-bordered",
    placeholder: "新分组名称",
    onSubmit: name => addSection(name),
  }));
  // 侧边栏「＋ 新建项目」内联创建器
  projectCreatorEl = makeInlineCreator({
    buttonLabel: "＋ 新建项目",
    buttonClass: "creator-btn-sidebar",
    placeholder: "新项目名称",
    onSubmit: name => createProject(name),
  });
  $("#btn-new-project").replaceWith(projectCreatorEl);
  $("#detail-close").addEventListener("click", closeDetail);
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    clearTLSelect(); // 时间线多选：Esc 清空
    if (state.detailId) closeDetail();
  });

  // 移动端抽屉菜单
  const sidebar = $("#sidebar"), backdrop = $("#sidebar-backdrop");
  function closeMenu() { sidebar.classList.remove("open"); backdrop.classList.add("hidden"); }
  $("#btn-menu").addEventListener("click", () => {
    sidebar.classList.add("open");
    backdrop.classList.remove("hidden");
  });
  $("#btn-menu-close").addEventListener("click", closeMenu);
  backdrop.addEventListener("click", closeMenu);
  $$("#sidebar .nav-item").forEach(n => n.addEventListener("click", closeMenu));

  // 退出登录：清除 token 并回到 /（服务端将返回登录页）
  $("#btn-logout").addEventListener("click", () => {
    clearToken();
    location.href = "/";
  });

  // 登录遮罩提交：保存 token 并尝试加载数据
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
      showLogin(err.message === "unauthorized" ? "token 不正确，请重试" : "加载失败: " + err.message);
    }
  });

  if (!getToken()) {
    // 无 token：先尝试无认证访问（--no-auth 模式可直接进入），401 时显示登录遮罩
    boot().then(render).catch(e => {
      if (e.message !== "unauthorized") {
        $("#view-container").innerHTML = `<div class="tl-empty-hint">加载失败: ${esc(e.message)}</div>`;
      }
    });
    return;
  }
  boot().then(render).catch(e => {
    if (e.message !== "unauthorized") {
      $("#view-container").innerHTML = `<div class="tl-empty-hint">加载失败: ${esc(e.message)}</div>`;
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
