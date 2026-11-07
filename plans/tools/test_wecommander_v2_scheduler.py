"""Tests for the WECOMMANDER V2 scheduler and plan-document consistency.

Run: python3 -m unittest discover -s plans/tools -p 'test_*.py'
"""
import copy
import datetime as dt
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wecommander_v2_scheduler as ws  # noqa: E402

DATA = ws.load(actuals_path=None)
SCENARIOS = sorted(DATA["scenarios"])


def fresh():
    return copy.deepcopy(DATA)


class DataModelTests(unittest.TestCase):
    def test_validates_clean(self):
        self.assertEqual(ws.validate(fresh()), [])

    def test_exactly_43_unique_packages(self):
        codes = [p["code"] for p in DATA["packages"]]
        self.assertEqual(len(codes), 43)
        self.assertEqual(len(set(codes)), 43)
        self.assertEqual(sorted(c for c in codes if c.startswith("A")), [f"A{i:02d}" for i in range(1, 31)])
        self.assertEqual(sorted(c for c in codes if c.startswith("B")), [f"B{i:02d}" for i in range(1, 14)])

    def test_unknown_dependency_is_reported(self):
        d = fresh()
        d["packages"][0]["deps"].append("Z99")
        self.assertTrue(any("unknown dependency Z99" in e for e in ws.validate(d)))

    def test_cycle_is_detected(self):
        d = fresh()
        pk = {p["code"]: p for p in d["packages"]}
        pk["B01"]["deps"].append("B02")  # B02 already depends on B01
        errs = ws.validate(d)
        self.assertTrue(any(e.startswith("dependency cycle") for e in errs), errs)
        with self.assertRaises(ws.PlanError):
            ws.schedule(d, "S2")

    def test_find_cycle_unit(self):
        self.assertIsNone(ws.find_cycle({"a": ["b"], "b": []}))
        self.assertEqual(ws.find_cycle({"a": ["b"], "b": ["c"], "c": ["a"]}), ["a", "b", "c", "a"])

    def test_duplicate_code_is_reported(self):
        d = fresh()
        d["packages"].append(copy.deepcopy(d["packages"][0]))
        self.assertIn("duplicate package codes", ws.validate(d))

    def test_every_item_on_exactly_one_lane(self):
        d = fresh()
        d["scenarios"]["S2"]["lanes"]["D2"].append("B01")
        self.assertTrue(any("exactly one lane" in e for e in ws.validate(d)))

    def test_milestone_scopes_cover_packages(self):
        d = fresh()
        d["milestones"][0]["scope"].remove("B01")
        self.assertTrue(any("milestone scopes" in e for e in ws.validate(d)))

    def test_user_mode_1_stable_milestone_exists(self):
        ms = {m["id"]: m for m in DATA["milestones"]}
        self.assertIn("U1", ms)
        self.assertEqual(ms["U1"]["stabilization"], "S-U1")
        stab = {s["code"]: s for s in DATA["stabilizations"]}
        # U1 must not wait for team vault, sync, mobile or AI.
        def ancestors(code, acc=None):
            acc = set() if acc is None else acc
            its = ws.items(DATA)
            for dep in its[code]["deps"]:
                if dep not in acc:
                    acc.add(dep)
                    ancestors(dep, acc)
            return acc
        anc = ancestors("S-U1")
        for forbidden in ("A20", "A22", "A24", "A28", "A29", "B10"):
            self.assertNotIn(forbidden, anc)
        for required in ("A04", "A05", "A06", "A07", "A08", "A09", "A10", "A11", "A19"):
            self.assertIn(required, anc)
        self.assertGreaterEqual(stab["S-U1"]["weeks"], 4)


class ScheduleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.S = {s: ws.schedule(fresh(), s) for s in SCENARIOS}

    def test_dependencies_respected(self):
        its = ws.items(DATA)
        for s, sch in self.S.items():
            for code, it in sch["items"].items():
                for dep in its[code]["deps"]:
                    self.assertLessEqual(sch["items"][dep]["end"], it["start"], f"{s}: {code} starts before {dep} ends")

    def test_no_lane_runs_two_items_at_once(self):
        for s, sch in self.S.items():
            by_lane = {}
            for code, it in sch["items"].items():
                by_lane.setdefault(it["lane"], []).append((it["start"], it["end"], code))
            for lane, spans in by_lane.items():
                spans.sort()
                for (a0, a1, ac), (b0, b1, bc) in zip(spans, spans[1:]):
                    self.assertLessEqual(a1, b0, f"{s}/{lane}: {ac} overlaps {bc}")

    def test_new_lanes_respect_onboarding(self):
        on = DATA["parameters"]["onboarding_weeks"]
        for s, sch in self.S.items():
            for it in sch["items"].values():
                if it["lane"] != "D1":
                    self.assertGreaterEqual(it["start"], on)

    def test_stabilization_has_no_scope_work_and_fixed_length(self):
        stab = {x["code"]: x for x in DATA["stabilizations"]}
        for s, sch in self.S.items():
            for m in DATA["milestones"]:
                st = m["stabilization"]
                if not st:
                    continue
                window = sch["items"][st]
                self.assertEqual(window["weeks"], stab[st]["weeks"])
                for code in m["scope"]:
                    self.assertLessEqual(sch["items"][code]["end"], window["start"],
                                         f"{s}: {code} still in development during {st}")

    def test_release_dates_after_scope_completion(self):
        for s, sch in self.S.items():
            mw = ws.milestone_weeks(DATA, sch)
            for m in DATA["milestones"]:
                for code in m["scope"]:
                    self.assertGreaterEqual(mw[m["id"]], sch["items"][code]["end"])
                self.assertGreaterEqual(ws.target_week(DATA, mw[m["id"]]), mw[m["id"]])

    def test_release_order(self):
        for s, sch in self.S.items():
            mw = ws.milestone_weeks(DATA, sch)
            self.assertLess(mw["M2"], mw["U1"])
            self.assertLess(mw["U1"], mw["M3"])
            self.assertLess(mw["U1"], mw["M6"])
            self.assertLessEqual(mw["M5"], mw["M6"])
            self.assertLessEqual(mw["M4"], mw["M6"])
            self.assertLess(mw["M6"], mw["M7"])

    def test_deterministic(self):
        a = json.dumps(ws.render_blocks(fresh()), sort_keys=True)
        b = json.dumps(ws.render_blocks(fresh()), sort_keys=True)
        self.assertEqual(a, b)

    def test_capacity_parameter_changes_durations(self):
        slow = ws.schedule(fresh(), "S2", capacity=0.6)
        normal = self.S["S2"]
        self.assertGreater(slow["items"]["A02"]["weeks"], normal["items"]["A02"]["weeks"])

    def test_coordination_factor_is_separate(self):
        a = ws.schedule(fresh(), "S2", coordination=1.0)
        b = ws.schedule(fresh(), "S2", coordination=1.5)
        self.assertLess(a["items"]["A09"]["weeks"], b["items"]["A09"]["weeks"])

    def test_stabilization_weeks_configurable(self):
        longer = ws.schedule(fresh(), "S2", stabilization_weeks={"S-U1": 8})
        self.assertEqual(longer["items"]["S-U1"]["weeks"], 8)

    def test_buffer_configurable(self):
        self.assertEqual(ws.target_week(DATA, 100, 0.0), 100)
        self.assertEqual(ws.target_week(DATA, 100, 0.2), 120)

    def test_critical_path_is_contiguous(self):
        for s, sch in self.S.items():
            for target in ("S-U1", "S-STABLE"):
                path = ws.critical_path(DATA, sch, target)
                self.assertEqual(path[-1], target)
                for prev, nxt in zip(path, path[1:]):
                    self.assertEqual(sch["items"][prev]["end"], sch["items"][nxt]["start"], f"{s}: {prev} -> {nxt}")

    def test_more_developers_never_later(self):
        mw = {s: ws.milestone_weeks(DATA, sch) for s, sch in self.S.items()}
        for m in ("M2", "U1", "M5", "M6"):
            self.assertLessEqual(mw["S2"][m], mw["S1"][m])
            self.assertLessEqual(mw["S4"][m], mw["S2"][m])

    def test_agent_security_not_postponed(self):
        for s, sch in self.S.items():
            # B01 is the first item on D1 and B03/B02 complete before any A-package beyond M1 is released.
            self.assertEqual(sch["items"]["B01"]["start"], 0)
            self.assertLessEqual(sch["items"]["B02"]["end"], ws.milestone_weeks(DATA, sch)["M2"])


class VelocityTests(unittest.TestCase):
    def test_actuals_pin_and_scale_remaining(self):
        d = fresh()
        base = ws.schedule(d, "S2")
        a01 = base["items"]["A02"]
        d["_actuals"] = {"scenario": "S2", "reestimates": {},
                         "completed": {"A02": {"actual_mh": 6.75, "lane": "D2",
                                               "start": str(ws.monday(d, a01["start"])),
                                               "end": str(ws.friday(d, a01["end"] + 1))}}}
        self.assertAlmostEqual(ws.velocity_factor(d), 1.5)
        new = ws.schedule(d, "S2")
        self.assertTrue(new["items"]["A02"]["pinned"])
        self.assertEqual(new["items"]["A02"]["end"], a01["end"] + 1)
        self.assertGreater(new["items"]["A09"]["weeks"], base["items"]["A09"]["weeks"])

    def test_reestimate_overrides_velocity(self):
        d = fresh()
        d["_actuals"] = {"scenario": "S2", "completed": {}, "reestimates": {"A09": 9.0}}
        self.assertEqual(ws.schedule(d, "S2")["items"]["A09"]["weeks"], 13)  # ceil(9/0.8*1.1)

    def test_actuals_file_is_valid(self):
        act = json.loads(ws.ACTUALS.read_text(encoding="utf-8"))
        self.assertIn("completed", act)
        self.assertIn("reestimates", act)


class DocumentConsistencyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = {k: p.read_text(encoding="utf-8") for k, p in ws.DOCS.items()}

    def test_generated_sections_in_sync(self):
        self.assertEqual(ws.check_docs(ws.load()), [])

    def test_all_docs_state_43_packages_and_u1(self):
        for k in ("master", "calendar", "deps", "release"):
            self.assertIn("43", self.text[k], k)
            self.assertIn("User Mode 1.0 Stable", self.text[k], k)

    def test_master_plan_has_section_per_package(self):
        heads = set(re.findall(r"^#{3,4} ([AB]\d\d) ·", self.text["master"], re.M))
        self.assertEqual(heads, {p["code"] for p in DATA["packages"]})

    def test_release_criteria_has_section_per_milestone(self):
        heads = set(re.findall(r"^### (M\d|U1) —", self.text["release"], re.M))
        self.assertEqual(heads, {m["id"] for m in DATA["milestones"]})

    def test_gantt_matches_schedule_tables(self):
        data = ws.load()
        S = ws.all_schedules(data)
        for s in SCENARIOS:
            seg = self.text["calendar"].split(ws.BEGIN.format(f"gantt-{s}"))[1].split(ws.END.format(f"gantt-{s}"))[0]
            rows = re.findall(r":([A-Z0-9]+), (\d{4}-\d\d-\d\d), (\d{4}-\d\d-\d\d)$", seg, re.M)
            self.assertEqual(len(rows), len(S[s]["items"]))
            for code, a, b in rows:
                key = next(c for c in S[s]["items"] if c.replace("-", "") == code)
                it = S[s]["items"][key]
                self.assertEqual(a, str(ws.monday(data, it["start"])))
                self.assertEqual(b, str(ws.friday(data, it["end"])))
            table = self.text["calendar"].split(f"#### {s} (")[-1]
            for key, it in S[s]["items"].items():
                self.assertIn(f"| {key} |", table)

    def test_no_hand_written_dates_outside_generated_blocks(self):
        """Dates in the calendar and release criteria come only from the scheduler."""
        for k in ("calendar", "release"):
            text = self.text[k]
            stripped = re.sub(r"<!-- GENERATED:BEGIN (.+?) -->.*?<!-- GENERATED:END \1 -->", "", text, flags=re.S)
            dates = set(re.findall(r"20\d\d-\d\d-\d\d", stripped)) - {DATA["start_date"], "2026-11-07"}
            self.assertEqual(dates, set(), f"{k}: hand-written dates {sorted(dates)}")


if __name__ == "__main__":
    unittest.main()
