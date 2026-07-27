#!/usr/bin/env python3
"""把 Asana 导出的 asana_tasks_full.json（中文键）转换为应用内部格式 data/tasks.json。

内部格式:
{
  "sections": ["To do", "In progress", ...],
  "tasks": [
    {
      "id": str,            # 来自 gid
      "name": str,
      "section": str,
      "assignee": str,
      "start_on": "YYYY-MM-DD" | null,
      "due_on": "YYYY-MM-DD" | null,
      "completed": bool,
      "category": str,
      "effort": str,
      "priority": str,
      "dependencies": [task_id, ...],   # 由任务名解析为 id
      "notes": str,
      "link": str,
      "order": int                     # section 内排序
    }
  ]
}
"""
import json
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(BASE, "..", "asana_tasks_full.json")
DST = os.path.join(BASE, "data", "tasks.json")


def main():
    with open(SRC, encoding="utf-8") as f:
        raw = json.load(f)

    name_to_id = {}
    for t in raw:
        name_to_id.setdefault(t["任务名称"].strip(), t["gid"])

    sections = []
    tasks = []
    unresolved = []
    per_section_count = {}
    for t in raw:
        sec = t["分组"] or "To do"
        if sec not in sections:
            sections.append(sec)
        deps = []
        dep_raw = (t.get("前置依赖") or "").strip()
        if dep_raw:
            for name in dep_raw.split(";"):
                name = name.strip()
                if not name:
                    continue
                if name in name_to_id:
                    deps.append(name_to_id[name])
                else:
                    unresolved.append((t["任务名称"], name))
        idx = per_section_count.get(sec, 0)
        per_section_count[sec] = idx + 1
        tasks.append({
            "id": t["gid"],
            "name": t["任务名称"],
            "section": sec,
            "assignee": t.get("负责人") or "",
            "start_on": t.get("开始日期") or None,
            "due_on": t.get("截止日期") or None,
            "completed": t.get("已完成") == "是",
            "category": t.get("Category") or "",
            "effort": t.get("Effort") or "",
            "priority": t.get("Priority") or "",
            "dependencies": deps,
            "notes": "",
            "link": t.get("任务链接") or "",
            "order": idx,
        })

    db = {"sections": sections, "tasks": tasks}
    os.makedirs(os.path.dirname(DST), exist_ok=True)
    with open(DST, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=1)
    print(f"converted {len(tasks)} tasks, sections={sections}")
    for src_name, dep_name in unresolved:
        print(f"WARN unresolved dependency: {src_name!r} -> {dep_name!r}", file=sys.stderr)


if __name__ == "__main__":
    main()
