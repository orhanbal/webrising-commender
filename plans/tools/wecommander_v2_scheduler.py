#!/usr/bin/env python3
"""WECOMMANDER V2 schedule calculator.

Reads plans/data/wecommander_v2_work_packages.json (and the optional actuals
file), schedules every work package onto developer lanes with dependency and
capacity constraints, and renders the generated sections of the four V2 plan
documents. Standard library only; output is deterministic.

Usage:
  python3 plans/tools/wecommander_v2_scheduler.py validate
  python3 plans/tools/wecommander_v2_scheduler.py render --write   # update docs
  python3 plans/tools/wecommander_v2_scheduler.py check            # docs in sync?
  python3 plans/tools/wecommander_v2_scheduler.py summary [--scenario S2]

Model (see DEVELOPMENT_CALENDAR §1):
  weeks(package) = ceil(effort_mh * velocity / capacity * coordination)
  A lane runs one item at a time, in its queue order. An item starts when the
  lane is free and every dependency has finished. Stabilization items take a
  fixed number of weeks and contain no feature work. Lanes other than D1 start
  after the onboarding weeks. Target date = plan end + ceil(end_week * buffer).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "plans" / "data" / "wecommander_v2_work_packages.json"
ACTUALS = ROOT / "plans" / "data" / "wecommander_v2_actuals.json"
DOCS = {
    "master": ROOT / "plans" / "WECOMMANDER_V2_MASTER_PLAN.md",
    "calendar": ROOT / "plans" / "WECOMMANDER_V2_DEVELOPMENT_CALENDAR.md",
    "deps": ROOT / "plans" / "WECOMMANDER_V2_DEPENDENCY_MATRIX.md",
    "release": ROOT / "plans" / "WECOMMANDER_V2_RELEASE_CRITERIA.md",
    "sprint": ROOT / "plans" / "WECOMMANDER_V2_SPRINT_01.md",
}
BEGIN = "<!-- GENERATED:BEGIN {} -->"
END = "<!-- GENERATED:END {} -->"


class PlanError(Exception):
    pass


# ---------------------------------------------------------------- loading
def load(data_path: Path = DATA, actuals_path: Path | None = ACTUALS) -> dict:
    data = json.loads(Path(data_path).read_text(encoding="utf-8"))
    actuals = {"completed": {}, "reestimates": {}, "scenario": None}
    if actuals_path and Path(actuals_path).exists():
        actuals.update(json.loads(Path(actuals_path).read_text(encoding="utf-8")))
    data["_actuals"] = actuals
    return data


def items(data: dict) -> dict:
    """All schedulable items: packages and stabilization periods."""
    out = {}
    for p in data["packages"]:
        out[p["code"]] = {"kind": "package", "deps": list(p["deps"]), **p}
    for s in data["stabilizations"]:
        out[s["code"]] = {"kind": "stabilization", "deps": list(s["deps"]), **s}
    return out


def mid(p: dict) -> float:
    return (p["effort"]["low"] + p["effort"]["high"]) / 2


# ---------------------------------------------------------------- validation
def find_cycle(graph: dict[str, list[str]]) -> list[str] | None:
    """Return one dependency cycle as a list of codes, or None."""
    state: dict[str, int] = {}
    stack: list[str] = []

    def visit(node: str) -> list[str] | None:
        state[node] = 1
        stack.append(node)
        for dep in sorted(graph.get(node, [])):
            if state.get(dep) == 1:
                return stack[stack.index(dep):] + [dep]
            if state.get(dep) is None and dep in graph:
                found = visit(dep)
                if found:
                    return found
        stack.pop()
        state[node] = 2
        return None

    for node in sorted(graph):
        if state.get(node) is None:
            found = visit(node)
            if found:
                return found
    return None


def validate(data: dict) -> list[str]:
    errors: list[str] = []
    codes = [p["code"] for p in data["packages"]]
    stab = [s["code"] for s in data["stabilizations"]]
    if len(codes) != len(set(codes)):
        errors.append("duplicate package codes")
    if len(codes) != 43:
        errors.append(f"expected 43 work packages, found {len(codes)}")
    all_items = items(data)
    for code, it in all_items.items():
        for dep in it["deps"]:
            if dep not in all_items:
                errors.append(f"{code}: unknown dependency {dep}")
        if it["kind"] == "package":
            if it["effort"]["low"] > it["effort"]["high"] or it["effort"]["low"] <= 0:
                errors.append(f"{code}: invalid effort range")
    cycle = find_cycle({c: it["deps"] for c, it in all_items.items()})
    if cycle:
        errors.append("dependency cycle: " + " -> ".join(cycle))
    ms_ids = {m["id"] for m in data["milestones"]}
    for p in data["packages"]:
        if p["milestone"] not in ms_ids:
            errors.append(f"{p['code']}: unknown milestone {p['milestone']}")
    scoped = [c for m in data["milestones"] for c in m["scope"]]
    if sorted(scoped) != sorted(codes):
        missing = sorted(set(codes) - set(scoped))
        extra = sorted(c for c in set(scoped) if scoped.count(c) > 1 or c not in codes)
        errors.append(f"milestone scopes must cover each package once (missing {missing}, extra {extra})")
    for m in data["milestones"]:
        for c in m["scope"]:
            if c in all_items and all_items[c].get("milestone") != m["id"]:
                errors.append(f"{c}: package milestone differs from scope of {m['id']}")
        if m["stabilization"] and m["stabilization"] not in stab:
            errors.append(f"{m['id']}: unknown stabilization {m['stabilization']}")
    for name, sc in data["scenarios"].items():
        queued = [c for q in sc["lanes"].values() for c in q]
        if sorted(queued) != sorted(all_items):
            missing = sorted(set(all_items) - set(queued))
            dup = sorted({c for c in queued if queued.count(c) > 1})
            errors.append(f"{name}: every item must be on exactly one lane (missing {missing}, duplicate {dup})")
    for ph in data["phases"]:
        for c in ph["members"]:
            if c not in all_items:
                errors.append(f"phase {ph['id']}: unknown member {c}")
    members = [c for ph in data["phases"] for c in ph["members"]]
    if sorted(members) != sorted(all_items):
        errors.append("phases must cover every item exactly once")
    for gate in data["gates"]:
        if gate["after"] not in all_items and gate["after"] not in ms_ids:
            errors.append(f"gate {gate['id']}: unknown anchor {gate['after']}")
    return errors


# ---------------------------------------------------------------- scheduling
def velocity_factor(data: dict) -> float:
    done = data["_actuals"].get("completed", {})
    pk = {p["code"]: p for p in data["packages"]}
    planned = sum(mid(pk[c]) for c in done if c in pk)
    actual = sum(float(v["actual_mh"]) for c, v in done.items() if c in pk)
    return round(actual / planned, 3) if planned else 1.0


def week_of(data: dict, date: str) -> int:
    start = dt.date.fromisoformat(data["start_date"])
    return (dt.date.fromisoformat(date) - start).days // 7


def schedule(data: dict, scenario: str, capacity: float | None = None,
             coordination: float | None = None, stabilization_weeks: dict | None = None,
             onboarding: int | None = None) -> dict:
    errors = validate(data)
    if errors:
        raise PlanError("; ".join(errors))
    params = data["parameters"]
    sc = data["scenarios"][scenario]
    cap = capacity if capacity is not None else params["capacity_mh_per_week"]
    coord = coordination if coordination is not None else sc["coordination_factor"]
    onboard = params["onboarding_weeks"] if onboarding is None else onboarding
    stab_w = {s["code"]: s["weeks"] for s in data["stabilizations"]}
    stab_w.update(stabilization_weeks or {})
    all_items = items(data)
    act = data["_actuals"]
    pinned = act.get("completed", {}) if act.get("scenario") in (None, scenario) else {}
    factor = velocity_factor(data)
    reest = act.get("reestimates", {})

    def duration(code: str) -> int:
        it = all_items[code]
        if it["kind"] == "stabilization":
            return int(stab_w[code])
        effort = float(reest.get(code, mid(it)))
        if code not in reest:
            effort *= factor
        return max(1, math.ceil(round(effort / cap * coord, 6)))

    queues = {lane: list(q) for lane, q in sorted(sc["lanes"].items())}
    free = {lane: (0 if lane == "D1" else onboard) for lane in queues}
    result: dict[str, dict] = {}
    while any(queues.values()):
        progressed = False
        for lane in queues:
            while queues[lane]:
                code = queues[lane][0]
                deps = all_items[code]["deps"]
                if not all(d in result for d in deps):
                    break
                if code in pinned:
                    start = week_of(data, pinned[code]["start"])
                    end = week_of(data, pinned[code]["end"]) + 1
                else:
                    start = max([free[lane]] + [result[d]["end"] for d in deps])
                    end = start + duration(code)
                result[code] = {"lane": lane, "start": start, "end": end, "weeks": end - start,
                                "kind": all_items[code]["kind"], "pinned": code in pinned}
                free[lane] = max(free[lane], end)
                queues[lane].pop(0)
                progressed = True
        if not progressed:
            heads = {lane: q[0] for lane, q in queues.items() if q}
            raise PlanError(f"{scenario}: lane order deadlocks on {heads}")
    return {"scenario": scenario, "items": result, "capacity": cap, "coordination": coord,
            "velocity": factor, "lanes": list(queues)}


def milestone_weeks(data: dict, sched: dict) -> dict[str, int]:
    out = {}
    for m in data["milestones"]:
        codes = list(m["scope"]) + ([m["stabilization"]] if m["stabilization"] else [])
        out[m["id"]] = max(sched["items"][c]["end"] for c in codes)
    return out


def target_week(data: dict, end_week: int, buffer: float | None = None) -> int:
    b = data["parameters"]["buffer_ratio"] if buffer is None else buffer
    return end_week + math.ceil(end_week * b)


def critical_path(data: dict, sched: dict, target: str = "S-STABLE") -> list[str]:
    """Walk back from target through the item that determined each start."""
    its = sched["items"]
    all_items = items(data)
    path = [target]
    code = target
    while True:
        start = its[code]["start"]
        deps = sorted(d for d in all_items[code]["deps"] if its[d]["end"] == start)
        lane_prev = sorted(c for c, v in its.items()
                           if c != code and v["lane"] == its[code]["lane"] and v["end"] == start)
        nxt = (deps or lane_prev or [None])[0]
        if nxt is None:
            break
        path.append(nxt)
        code = nxt
    return list(reversed(path))


# ---------------------------------------------------------------- rendering helpers
def monday(data: dict, week: int) -> dt.date:
    return dt.date.fromisoformat(data["start_date"]) + dt.timedelta(weeks=week)


def friday(data: dict, end_week: int) -> dt.date:
    return monday(data, end_week) - dt.timedelta(days=3)


def fmt(x: float) -> str:
    return f"{x:.2f}".rstrip("0").rstrip(".").replace(".", ",")


def names(data: dict) -> dict[str, str]:
    return {c: it["name"] for c, it in items(data).items()}


def totals(data: dict) -> dict:
    pk = data["packages"]
    out = {}
    for plan in ("A", "B"):
        sel = [p for p in pk if p["plan"] == plan]
        out[plan] = {"count": len(sel), "low": sum(p["effort"]["low"] for p in sel),
                     "mid": sum(mid(p) for p in sel), "high": sum(p["effort"]["high"] for p in sel)}
    out["all"] = {k: out["A"][k] + out["B"][k] for k in ("count", "low", "mid", "high")}
    return out


def all_schedules(data: dict) -> dict:
    return {s: schedule(data, s) for s in sorted(data["scenarios"])}


# ---------------------------------------------------------------- blocks
def block_effort(data, S):
    t = totals(data)
    rows = ["| Plan | Paket | Düşük | Orta nokta (takvim) | Yüksek |", "|---|---|---|---|---|"]
    for k, label in (("A", "A — User Mode"), ("B", "B — Agent Mode"), ("all", "**Toplam**")):
        rows.append(f"| {label} | {t[k]['count']} | {fmt(t[k]['low'])} MH | {fmt(t[k]['mid'])} MH | {fmt(t[k]['high'])} MH |")
    base = data["baseline_v0_1"]["total_mh"]
    rows.append(f"\nÖnceki sürüm (v0.1) toplamı: {fmt(base)} MH → bu sürüm: {fmt(t['all']['mid'])} MH "
                f"(fark {fmt(t['all']['mid'] - base)} MH). Hız katsayısı (actuals): {fmt(velocity_factor(data))}.")
    return "\n".join(rows)


def block_packages(data, S):
    rows = ["| Kod | Ad | Plan | Kilometre taşı | Öncelik | Efor (MH) | Ön koşullar |", "|---|---|---|---|---|---|---|"]
    for p in data["packages"]:
        rng = fmt(p["effort"]["low"]) if p["effort"]["low"] == p["effort"]["high"] else f"{fmt(p['effort']['low'])}–{fmt(p['effort']['high'])}"
        rows.append(f"| {p['code']} | {p['name']} | {p['plan']} | {p['milestone']} | {p['priority']} | {rng} | {', '.join(p['deps']) or '—'} |")
    return "\n".join(rows)


def block_milestones(data, S):
    ids = [m["id"] for m in data["milestones"]]
    head = "| Kilometre taşı | " + " | ".join(f"{s} plan | {s} hedef" for s in S) + " |"
    rows = [head, "|---|" + "---|" * (2 * len(S))]
    mw = {s: milestone_weeks(data, S[s]) for s in S}
    nm = {m["id"]: m["name"] for m in data["milestones"]}
    for i in ids:
        cells = []
        for s in S:
            w = mw[s][i]
            cells += [str(friday(data, w)), str(friday(data, target_week(data, w)))]
        rows.append(f"| **{i}** {nm[i]} | " + " | ".join(cells) + " |")
    return "\n".join(rows)


def block_milestones_default(data, S):
    s = data["parameters"]["default_scenario"]
    mw = milestone_weeks(data, S[s])
    rows = [f"| Kilometre taşı | Plan tarihi ({s}) | Hedef sürüm tarihi ({s}, tampon dahil) | Kapsam |", "|---|---|---|---|"]
    for m in data["milestones"]:
        w = mw[m["id"]]
        scope = ", ".join(m["scope"]) + (f" + {m['stabilization']}" if m["stabilization"] else "")
        rows.append(f"| **{m['id']}** {m['name']} | {friday(data, w)} | {friday(data, target_week(data, w))} | {scope} |")
    return "\n".join(rows)


def block_phases(data, S):
    out = []
    pk = {p["code"]: p for p in data["packages"]}
    for s, sch in S.items():
        out.append(f"\n#### {s} ({data['scenarios'][s]['label']})\n")
        out.append("| Aşama | Başlangıç | Plan bitişi | Süre (hafta) | Efor (MH) | Hedef (tampon dahil) |")
        out.append("|---|---|---|---|---|---|")
        for ph in data["phases"]:
            st = min(sch["items"][c]["start"] for c in ph["members"])
            en = max(sch["items"][c]["end"] for c in ph["members"])
            mh = sum(mid(pk[c]) for c in ph["members"] if c in pk)
            out.append(f"| {ph['name']} | {monday(data, st)} | {friday(data, en)} | {en - st} | {fmt(mh)} | {friday(data, target_week(data, en))} |")
    return "\n".join(out)


def block_critical(data, S):
    rows = ["| Senaryo | Kritik yol: User Mode 1.0 Stable | Kritik yol: V2 Stable |", "|---|---|---|"]
    for s, sch in S.items():
        rows.append(f"| {s} | {' → '.join(critical_path(data, sch, 'S-U1'))} | {' → '.join(critical_path(data, sch, 'S-STABLE'))} |")
    return "\n".join(rows)


def block_gantt(data, S, s):
    sch = S[s]
    nm = names(data)
    g = ["```mermaid", "gantt", f"    title WECOMMANDER V2 — {s} ({data['scenarios'][s]['label']})",
         "    dateFormat YYYY-MM-DD", "    axisFormat %b %y", "    excludes weekends"]
    for ph in data["phases"]:
        g.append(f"    section {ph['id']}")
        for c in sorted(ph["members"], key=lambda c: (sch["items"][c]["start"], c)):
            it = sch["items"][c]
            g.append(f"    {c} {nm[c][:38].replace(':', ' ')} ({it['lane']}) :{c.replace('-', '')}, "
                     f"{monday(data, it['start'])}, {friday(data, it['end'])}")
    g.append("```")
    return "\n".join(g)


def block_weekly(data, S, s=None):
    s = s or data["parameters"]["default_scenario"]
    sch = S[s]
    lanes = sch["lanes"]
    last = max(v["end"] for v in sch["items"].values())
    rows = ["| Hafta | Pazartesi | " + " | ".join(lanes) + " |", "|---|---|" + "---|" * len(lanes)]
    for w in range(last):
        cell = {lane: "—" for lane in lanes}
        for c, it in sorted(sch["items"].items()):
            if it["start"] <= w < it["end"]:
                cell[it["lane"]] = c
        rows.append(f"| W{w + 1} | {monday(data, w)} | " + " | ".join(cell[x] for x in lanes) + " |")
    return "\n".join(rows)


def block_monthly(data, S, s=None):
    s = s or data["parameters"]["default_scenario"]
    sch = S[s]
    months: dict[tuple, dict] = defaultdict(lambda: defaultdict(set))
    for c, it in sch["items"].items():
        for w in range(it["start"], it["end"]):
            d = monday(data, w)
            months[(d.year, d.month)][it["lane"]].add(c)
    lanes = sch["lanes"]
    rows = ["| Ay | " + " | ".join(lanes) + " |", "|---|" + "---|" * len(lanes)]
    for k in sorted(months):
        rows.append(f"| {k[0]}-{k[1]:02d} | " + " | ".join(", ".join(sorted(months[k][x])) or "—" for x in lanes) + " |")
    return "\n".join(rows)


def block_parallel(data, S, s=None):
    s = s or data["parameters"]["default_scenario"]
    sch = S[s]
    q: dict[tuple, dict] = defaultdict(lambda: defaultdict(list))
    for c, it in sorted(sch["items"].items(), key=lambda x: (x[1]["start"], x[0])):
        seen = set()
        for w in range(it["start"], it["end"]):
            d = monday(data, w)
            key = (d.year, (d.month - 1) // 3 + 1)
            if key not in seen:
                q[key][it["lane"]].append(c)
                seen.add(key)
    lanes = sch["lanes"]
    rows = ["| Çeyrek | " + " | ".join(f"{x} ({data['scenarios'][s]['lane_labels'][x]})" for x in lanes) + " |",
            "|---|" + "---|" * len(lanes)]
    for k in sorted(q):
        rows.append(f"| {k[0]} Ç{k[1]} | " + " | ".join(", ".join(q[k][x]) or "—" for x in lanes) + " |")
    return "\n".join(rows)


def block_wp_schedule(data, S):
    out = []
    pk = {p["code"]: p for p in data["packages"]}
    for s, sch in S.items():
        n = len(sch["lanes"])
        last = max(v["end"] for v in sch["items"].values())
        tot = sum(mid(p) for p in data["packages"]) * sch["coordination"] * sch["velocity"]
        capa = n * last * sch["capacity"]
        out.append(f"\n#### {s} ({data['scenarios'][s]['label']})\n")
        out.append(f"Efor × koordinasyon × hız = {fmt(tot)} MH; kapasite {n} × {last} hafta × {fmt(sch['capacity'])} = {fmt(capa)} MH; kullanım ≈ %{round(100 * tot / capa)}.\n")
        out.append("| Kalem | Tür | Kulvar | Başlangıç | Bitiş | Hafta |")
        out.append("|---|---|---|---|---|---|")
        for c, it in sorted(sch["items"].items(), key=lambda x: (x[1]["start"], x[1]["lane"], x[0])):
            kind = "paket" if c in pk else "stabilizasyon"
            out.append(f"| {c} | {kind} | {it['lane']} | {monday(data, it['start'])} | {friday(data, it['end'])} | {it['weeks']} |")
    return "\n".join(out)


def block_capacity(data, S):
    rows = ["| Senaryo | Efor × koordinasyon | Takvim (hafta) | Kapasite | Kullanım | User Mode 1.0 (plan / hedef) | V2 Stable (plan / hedef) |",
            "|---|---|---|---|---|---|---|"]
    for s, sch in S.items():
        mw = milestone_weeks(data, sch)
        n = len(sch["lanes"])
        last = max(v["end"] for v in sch["items"].values())
        tot = sum(mid(p) for p in data["packages"]) * sch["coordination"] * sch["velocity"]
        capa = n * last * sch["capacity"]
        rows.append(f"| {s} | {fmt(tot)} MH | {last} | {fmt(capa)} MH | %{round(100 * tot / capa)} | "
                    f"{friday(data, mw['U1'])} / {friday(data, target_week(data, mw['U1']))} | "
                    f"{friday(data, mw['M6'])} / {friday(data, target_week(data, mw['M6']))} |")
    return "\n".join(rows)


def block_baseline(data, S):
    base = data["baseline_v0_1"]
    rows = ["| Senaryo | Kilometre taşı | v0.1 plan | v0.2 plan | Fark (hafta) |", "|---|---|---|---|---|"]
    for s, sch in S.items():
        mw = milestone_weeks(data, sch)
        for m in data["milestones"]:
            new = friday(data, mw[m["id"]])
            old = base[s].get(m["id"])
            if old:
                diff = (new - dt.date.fromisoformat(old)).days // 7
                rows.append(f"| {s} | {m['id']} | {old} | {new} | {'+' if diff > 0 else ''}{diff} |")
            else:
                rows.append(f"| {s} | {m['id']} | — (yeni) | {new} | — |")
    return "\n".join(rows)


def block_releases(data, S):
    s = data["parameters"]["default_scenario"]
    sch = S[s]
    mw = milestone_weeks(data, sch)
    rel = [("Agent Mode v1.0", "M0", "production (promote-production)"),
           ("Desktop 0.1 prototip", "M1", "dahili"),
           ("Desktop 0.5 MVP", "M2", "davetli erken erişim"),
           ("**User Mode 1.0 Stable**", "U1", "stable (Windows, macOS, Linux)"),
           ("User Mode 1.x Beta", "M3", "beta kanalı"),
           ("Desktop 1.x + Agent Mode entegrasyonu", "M4", "beta → stable"),
           ("Termius eşitliği RC", "M5", "sürüm adayı"),
           ("**WECOMMANDER V2.0 Stable**", "M6", "stable"),
           ("V2.1 mobil ve kurumsal", "M7", "stable + mobil test kanalları")]
    rows = [f"| Sürüm | Kilometre taşı | Plan ({s}) | Hedef ({s}) | Kanal |", "|---|---|---|---|---|"]
    for name, m, ch in rel:
        rows.append(f"| {name} | {m} | {friday(data, mw[m])} | {friday(data, target_week(data, mw[m]))} | {ch} |")
    for code, label in (("B04", "Agent Mode v1.1 (MFA)"), ("B06", "Agent Mode v1.2 (web terminali)"), ("B12", "Agent Mode v1.3 (gözlem)")):
        it = sch["items"][code]
        rows.append(f"| {label} | — | {friday(data, it['end'])} | {friday(data, target_week(data, it['end']))} | production |")
    return "\n".join(rows)


def block_dep_matrix(data, S):
    s = data["parameters"]["default_scenario"]
    sch = S[s]
    all_items = items(data)
    rev = {c: sorted(d for d in all_items if c in all_items[d]["deps"]) for c in all_items}

    def ancestors(c, seen=None):
        seen = set() if seen is None else seen
        for d in all_items[c]["deps"]:
            if d not in seen:
                seen.add(d)
                ancestors(d, seen)
        return seen

    rows = [f"| Kalem | Ad | Doğrudan ön koşullar | Doğrudan bağımlılar | Tüm ön koşullar | {s}'de aynı anda çalışan |",
            "|---|---|---|---|---|---|"]
    order = sorted(all_items, key=lambda c: (all_items[c]["kind"] != "package", c[0] != "B", c))
    for c in order:
        it = sch["items"][c]
        par = sorted(d for d, v in sch["items"].items() if d != c and v["start"] < it["end"] and it["start"] < v["end"])
        rows.append(f"| {c} | {all_items[c]['name']} | {', '.join(all_items[c]['deps']) or '—'} | {', '.join(rev[c]) or '—'} | {len(ancestors(c))} | {', '.join(par) or '—'} |")
    return "\n".join(rows)


def block_dep_graph(data, S):
    all_items = items(data)
    g = ["```mermaid", "flowchart LR"]
    for c in sorted(all_items):
        g.append(f'    {c.replace("-", "_")}["{c}"]')
    for c in sorted(all_items):
        for d in sorted(all_items[c]["deps"]):
            g.append(f"    {d.replace('-', '_')} --> {c.replace('-', '_')}")
    g.append("```")
    return "\n".join(g)


def block_gates(data, S):
    rows = ["| Kapı | Ne zaman | Ad | Kontroller | Başarısızlıkta |", "|---|---|---|---|---|"]
    s = data["parameters"]["default_scenario"]
    mw = milestone_weeks(data, S[s])
    for g in data["gates"]:
        anchor = g["after"]
        w = S[s]["items"][anchor]["end"] if anchor in S[s]["items"] else mw[anchor]
        rows.append(f"| {g['id']} | {anchor} bitince ({s}: {friday(data, w)}) | {g['name']} | {'<br>'.join(g['checks'])} | {g['on_fail']} |")
    return "\n".join(rows)


def block_sprint(data, S):
    s = data["parameters"]["default_scenario"]
    sch = S[s]
    weeks = data["parameters"]["sprint_weeks"]
    rows = [f"| Kalem | Kulvar | Plan başlangıcı | Plan bitişi | Sprint 01 içindeki durum |", "|---|---|---|---|---|"]
    for c, it in sorted(sch["items"].items(), key=lambda x: (x[1]["start"], x[0])):
        if it["start"] < weeks:
            status = "sprint içinde biter" if it["end"] <= weeks else f"sprint sonunda devam eder (bitiş W{it['end']})"
            rows.append(f"| {c} | {it['lane']} | {monday(data, it['start'])} | {friday(data, it['end'])} | {status} |")
    rows.append(f"\nSprint 01 penceresi: {monday(data, 0)} – {friday(data, weeks)} ({weeks} hafta, {s}).")
    return "\n".join(rows)


BLOCKS = {
    "master": {"effort": block_effort, "packages": block_packages, "milestones-default": block_milestones_default,
               "gates": block_gates},
    "calendar": {"milestones": block_milestones, "phases": block_phases, "critical": block_critical,
                 "gantt-S2": lambda d, S: block_gantt(d, S, "S2"), "gantt-S4": lambda d, S: block_gantt(d, S, "S4"),
                 "gantt-S1": lambda d, S: block_gantt(d, S, "S1"), "weekly": block_weekly, "monthly": block_monthly,
                 "parallel": block_parallel, "releases": block_releases, "capacity": block_capacity,
                 "baseline": block_baseline, "wp-schedule": block_wp_schedule},
    "deps": {"dep-matrix": block_dep_matrix, "dep-graph": block_dep_graph, "critical": block_critical},
    "release": {"milestones-default": block_milestones_default, "releases": block_releases},
    "sprint": {"sprint": block_sprint, "gates": block_gates},
}


def render_blocks(data: dict) -> dict[str, dict[str, str]]:
    S = all_schedules(data)
    return {doc: {name: fn(data, S) for name, fn in blocks.items()} for doc, blocks in BLOCKS.items()}


def apply_blocks(text: str, blocks: dict[str, str]) -> str:
    for name, body in blocks.items():
        b, e = BEGIN.format(name), END.format(name)
        if b not in text or e not in text:
            raise PlanError(f"missing generated markers for {name}")
        head, rest = text.split(b, 1)
        _, tail = rest.split(e, 1)
        text = f"{head}{b}\n{body}\n{e}{tail}"
    return text


def check_docs(data: dict) -> list[str]:
    rendered = render_blocks(data)
    problems = []
    for doc, blocks in rendered.items():
        path = DOCS[doc]
        text = path.read_text(encoding="utf-8")
        try:
            if apply_blocks(text, blocks) != text:
                problems.append(f"{path.name}: generated sections are out of date (run render --write)")
        except PlanError as exc:
            problems.append(f"{path.name}: {exc}")
    return problems


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("validate")
    r = sub.add_parser("render")
    r.add_argument("--write", action="store_true")
    sub.add_parser("check")
    sm = sub.add_parser("summary")
    sm.add_argument("--scenario", default=None)
    args = ap.parse_args(argv)
    data = load()
    errors = validate(data)
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    if args.cmd == "validate":
        print("ok: 43 work packages, no cycles, lanes complete")
        return 0
    if args.cmd == "render":
        rendered = render_blocks(data)
        for doc, blocks in rendered.items():
            path = DOCS[doc]
            new = apply_blocks(path.read_text(encoding="utf-8"), blocks)
            if args.write:
                path.write_text(new, encoding="utf-8")
            else:
                print(f"# {path.name}\n" + "\n\n".join(blocks.values()))
        return 0
    if args.cmd == "check":
        problems = check_docs(data)
        print("\n".join(problems) or "ok: documents match the generated schedule")
        return 1 if problems else 0
    if args.cmd == "summary":
        S = all_schedules(data)
        sel = [args.scenario] if args.scenario else list(S)
        out = {s: {m: [str(friday(data, w)), str(friday(data, target_week(data, w)))]
                   for m, w in milestone_weeks(data, S[s]).items()} for s in sel}
        out["_effort_mh"] = totals(data)["all"]["mid"]
        out["_velocity"] = velocity_factor(data)
        print(json.dumps(out, ensure_ascii=False, indent=1))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
