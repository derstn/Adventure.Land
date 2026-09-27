#!/usr/bin/env python3
"""Adventure Land farm dashboard: a live, event-driven view built from the game's own CODE events.

    py tools/telemetry_dashboard.py                    # build dashboard/index.html once from data/*.jsonl
    py tools/telemetry_dashboard.py --watch [SEC]      # rebuild repeatedly (default 60s)
    py tools/telemetry_dashboard.py --serve [PORT]     # LIVE dashboard at http://127.0.0.1:8765/
    py tools/telemetry_dashboard.py --demo             # synthetic data -> dashboard/demo.html

Gold: the game reports gold moved between your own characters (merchant patrol offloading), and this
tool subtracts it, so gold per hour is real income minus real spending, never counted twice.

--serve is loopback-only. Pushes are accepted only from https://adventure.land (add more with
--allow-origin) and only with the secret in data/live_secret.txt; the tool also writes that secret to
the gitignored slot file adventureland/codes/LiveConfig.8.js so the game can read it.

data/ and dashboard/ are gitignored: they contain your account's data. History is only recorded while
--serve is running (there is no other data source), so gaps exist for any stretch the receiver was down.
"""
import argparse
import hmac
import json
import os
import random
import secrets
import sys
import threading
import time
from collections import Counter, defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUCKET_MS = 5 * 60 * 1000
MAX_GAP_S = 180  # cap each sample's uptime so offline gaps never count as farming time
LIVE_SLOT = 8
DEFAULT_ORIGINS = ("https://adventure.land", "https://www.adventure.land")
RANGES = {"1h": (3600e3, 60e3), "6h": (6 * 3600e3, 60e3), "24h": (24 * 3600e3, 300e3),
          "7d": (7 * 86400e3, 1800e3), "all": (None, 3600e3)}
NUM_KEYS = ("lv", "xp", "mx", "g", "hp", "mhp", "mp", "mmp", "pd", "dmg", "hl", "kb", "dt", "gs", "gr", "tk", "hr", "hpp", "mpp", "x", "y", "cc", "ccm", "ping", "xpm", "goldm", "luckm", "su")
STR_KEYS = ("c", "m", "md", "tg", "sv")
MAP_KEYS = ("dr", "tkm", "km", "bf")  # name -> number maps: drops, damage taken by monster type, kills by monster type
STAT_KEYS = ("str", "int", "dex", "vit", "attack", "frequency", "speed", "range", "armor", "resistance",
             "apiercing", "rpiercing", "evasion", "reflection", "crit", "lifesteal", "manasteal", "dreturn", "mp_cost")
EQUIP_SLOTS = ("mainhand", "offhand", "helmet", "chest", "pants", "shoes", "gloves", "cape", "belt",
               "ring1", "ring2", "earring1", "earring2", "amulet", "orb")


# ---------------------------------------------------------------- files
def load_jsonl(path):
    rows = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        rows.append(json.loads(line))
                    except ValueError:
                        pass
    return rows


def append_jsonl(path, rows):
    if rows:
        with open(path, "a", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, separators=(",", ":")) + "\n")


def trade_key(t):
    return (t.get("t"), t.get("buyer"), t.get("item"), t.get("lv"), t.get("slot"))


# ---------------------------------------------------------------- aggregation
def blank_char():
    return {"xp": 0, "g": 0, "ge": 0, "dmg": 0, "hl": 0, "kb": 0, "dt": 0, "hp": 0, "mp": 0,
            "up": 0.0, "fs": 0.0, "pd": 0, "pn": 0, "dr": {}, "tk": 0, "hr": 0, "tkm": {}, "km": {}, "ccm": 0}


def build_buckets(samples, trades, bucket_ms=BUCKET_MS):
    by_char = defaultdict(list)
    for r in samples:
        if r.get("n") and isinstance(r.get("t"), (int, float)):
            by_char[r["n"]].append(r)
    buckets = {}

    def bucket(t):
        bt = int(t // bucket_ms * bucket_ms)
        return buckets.setdefault(bt, {"t": bt, "c": {}, "gold_net": 0, "sales_v": 0, "sales_n": 0, "votes": Counter()})

    latest = {}
    for name, rows in by_char.items():
        rows.sort(key=lambda r: r["t"])
        latest[name] = rows[-1]
        prev = None
        for r in rows:
            if prev is not None and r["t"] > prev["t"]:
                dt = (r["t"] - prev["t"]) / 1000.0
                up = min(dt, MAX_GAP_S)
                b = bucket(r["t"])
                c = b["c"].setdefault(name, blank_char())
                if r.get("lv") == prev.get("lv"):
                    xp = max(0, (r.get("xp") or 0) - (prev.get("xp") or 0))
                elif r.get("lv") == (prev.get("lv") or 0) + 1:
                    xp = max(0, (prev.get("mx") or 0) - (prev.get("xp") or 0)) + (r.get("xp") or 0)
                else:
                    xp = 0
                c["xp"] += xp
                gd = (r.get("g") or 0) - (prev.get("g") or 0)
                # Gold moved between our own characters is not income or spending: add back what this
                # character sent to them (gs) and subtract what it received from them (gr).
                ge = gd + (r.get("gs") or 0) - (r.get("gr") or 0)
                c["g"] += gd
                c["ge"] += ge
                b["gold_net"] += ge
                for k in ("dmg", "hl", "kb", "dt"):
                    c[k] += r.get(k) or 0
                c["hp"] += max(0, (prev.get("hpp") or 0) - (r.get("hpp") or 0))
                c["mp"] += max(0, (prev.get("mpp") or 0) - (r.get("mpp") or 0))
                c["up"] += up
                if (r.get("dmg") or 0) > 0:
                    c["fs"] += up
                if r.get("pd") is not None:
                    c["pd"] += r["pd"]
                    c["pn"] += 1
                for item, n in (r.get("dr") or {}).items():
                    c["dr"][item] = c["dr"].get(item, 0) + n
                c["ccm"] = max(c["ccm"], r.get("ccm") or 0)
                c["tk"] += r.get("tk") or 0
                c["hr"] += r.get("hr") or 0
                for key in ("tkm", "km"):
                    for mt, n in (r.get(key) or {}).items():
                        c[key][mt] = c[key].get(mt, 0) + n
                if r.get("c") != "merchant":
                    b["votes"][(r.get("m") or "?", r.get("md") or "unknown")] += 1
            prev = r
    for t in trades:
        b = bucket(t["t"])
        b["sales_v"] += (t.get("unit") or 0) * (t.get("q") or 1)
        b["sales_n"] += t.get("q") or 1
    out = []
    for bt in sorted(buckets):
        b = buckets[bt]
        votes = b.pop("votes")
        b["seg"] = "%s · %s" % votes.most_common(1)[0][0] if votes else None
        out.append(b)
    chars = [{"name": n, "class": r.get("c"), "level": r.get("lv"), "gold": r.get("g"), "t": r.get("t")}
             for n, r in sorted(latest.items())]
    return out, chars


def build_data(samples, trades, bucket_ms=BUCKET_MS, title="Adventure Land farm dashboard", now_rows=None, events=None):
    if not now_rows:  # static builds: the newest sample per character stands in for the live state
        newest = {}
        for r in samples:
            if r.get("n") and (r["n"] not in newest or r["t"] > newest[r["n"]]["t"]):
                newest[r["n"]] = r
        now_rows = list(newest.values())
    buckets, chars = build_buckets(samples, trades, bucket_ms)
    trades = sorted(trades, key=lambda t: t["t"])
    return {"generated": int(time.time() * 1000), "bucketMs": bucket_ms, "chars": chars, "buckets": buckets,
            "trades": trades[-2000:], "title": title, "now": now_rows or [], "events": events or []}


def render_page(data, feed):
    with open(os.path.join(ROOT, "tools", "dashboard_template.html"), encoding="utf-8") as f:
        template = f.read()
    blob = json.dumps(data, separators=(",", ":")).replace("</", "<\\/")
    return template.replace("__DATA__", blob).replace("__FEED__", json.dumps(feed))


def build_dashboard(samples, trades, out_path, title="Adventure Land farm dashboard", events=None, upgrades=None):
    data = build_data(samples, trades, BUCKET_MS, title, None, events)
    data["upgradeSlots"] = upgrade_slot_stats(upgrades or [])
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(render_page(data, None))
    return len(data["buckets"])


# ---------------------------------------------------------------- demo data
def make_demo(hours=10):
    """Returns (samples, trades, events, upgrades)."""
    # Synthetic but plausible data so the dashboard can be previewed without any real telemetry.
    rnd = random.Random(7)
    now = int(time.time() * 1000)
    start = now - hours * 3600 * 1000
    cast = [("DerstnTanks", "warrior", 68, 900), ("Derstn", "ranger", 72, 1000),
            ("DerstnHeals", "priest", 67, 700), ("SuperSellin", "merchant", 54, 0)]
    state = {n: {"xp": 40000, "g": 90000 if n != "SuperSellin" else 500000000, "lv": lv, "hpp": 5000, "mpp": 6000}
             for n, _, lv, _ in cast}
    demo_gear = {
        "DerstnTanks": {"mainhand": {"n": "vlicense", "l": 7}, "offhand": {"n": "vshield", "l": 6},
                        "helmet": {"n": "phelmet", "l": 5}, "chest": {"n": "coat1", "l": 6, "s": "str"},
                        "pants": {"n": "pants1", "l": 6, "s": "str"}, "shoes": {"n": "wshoes", "l": 5},
                        "gloves": {"n": "gloves1", "l": 5}, "belt": {"n": "strbelt", "l": 3},
                        "amulet": {"n": "stramulet", "l": 3}, "ring1": {"n": "cring", "l": 2}},
        "Derstn": {"mainhand": {"n": "firebow", "l": 7}, "helmet": {"n": "phelmet", "l": 4},
                   "chest": {"n": "coat", "l": 7, "s": "dex"}, "pants": {"n": "pants", "l": 6, "s": "dex"},
                   "shoes": {"n": "wshoes", "l": 6}, "gloves": {"n": "gloves", "l": 5},
                   "belt": {"n": "dexbelt", "l": 3}, "amulet": {"n": "dexamulet", "l": 3},
                   "ring1": {"n": "cring", "l": 2}, "ring2": {"n": "zapper", "l": 1}},
        "DerstnHeals": {"mainhand": {"n": "wattire", "l": 0}, "helmet": {"n": "wcap", "l": 4},
                         "chest": {"n": "wattire", "l": 6, "s": "int"}, "pants": {"n": "wbreeches", "l": 5, "s": "int"},
                         "shoes": {"n": "wshoes", "l": 5}, "gloves": {"n": "wgloves", "l": 4},
                         "belt": {"n": "intbelt", "l": 3}, "amulet": {"n": "intamulet", "l": 3},
                         "orb": {"n": "orbg", "l": 2}},
        "SuperSellin": {"mainhand": {"n": "gstaff", "l": 1}, "helmet": {"n": "hood", "l": 0},
                        "chest": {"n": "coat", "l": 1}}
    }
    demo_stats = {
        "DerstnTanks": {"str": 210, "int": 20, "dex": 20, "vit": 60, "attack": 640, "frequency": 1.6,
                        "speed": 90, "range": 25, "armor": 480, "resistance": 300, "apiercing": 5, "rpiercing": 5,
                        "evasion": 15, "reflection": 0, "crit": 8, "lifesteal": 0, "manasteal": 0, "dreturn": 12, "mp_cost": 30},
        "Derstn": {"str": 20, "int": 20, "dex": 235, "vit": 45, "attack": 780, "frequency": 1.9,
                   "speed": 95, "range": 150, "armor": 220, "resistance": 210, "apiercing": 12, "rpiercing": 12,
                   "evasion": 22.5, "reflection": 0, "crit": 14.5, "lifesteal": 0, "manasteal": 0, "dreturn": 0, "mp_cost": 24},
        "DerstnHeals": {"str": 20, "int": 200, "dex": 20, "vit": 40, "attack": 420, "frequency": 1.3,
                        "speed": 90, "range": 130, "armor": 200, "resistance": 260, "apiercing": 6, "rpiercing": 6,
                        "evasion": 10, "reflection": 0, "crit": 5, "lifesteal": 0, "manasteal": 5, "dreturn": 0, "mp_cost": 40},
        "SuperSellin": {"str": 15, "int": 15, "dex": 15, "vit": 20, "attack": 40, "frequency": 1.0,
                        "speed": 100, "range": 20, "armor": 50, "resistance": 50, "apiercing": 0, "rpiercing": 0,
                        "evasion": 3, "reflection": 0, "crit": 0, "lifesteal": 0, "manasteal": 0, "dreturn": 0, "mp_cost": 10}
    }
    samples, trades, events = [], [], []
    pending_offload = 0
    t = start
    while t < now:
        frac = (t - start) / (now - start)
        mode = "support_tank" if frac < 0.5 else "free_for_all"
        boost = 1.0 if mode == "support_tank" else 1.55
        for name, cls, lv, base_dps in cast:
            s = state[name]
            fighting = cls != "merchant" and rnd.random() < 0.92
            dmg = int(base_dps * boost * 60 * rnd.uniform(0.7, 1.2)) if fighting and cls != "priest" else \
                int(base_dps * 0.2 * 60 * rnd.uniform(0.5, 1.2)) if fighting else 0
            hl = int(rnd.uniform(15000, 40000)) if cls == "priest" and fighting else 0
            kb = int(dmg / 900) if fighting else 0
            gain = int(kb * 960 * rnd.uniform(2.0, 3.2)) if cls != "merchant" else 0
            s["xp"] += gain
            mx = 2000000000
            if s["xp"] >= mx:
                s["xp"] -= mx
                s["lv"] += 1
            s["g"] += int(kb * 60 * rnd.uniform(1, 2)) if cls != "merchant" else 0
            gs = gr = 0
            if cls != "merchant" and s["g"] > 100000:  # patrol offload: fighter -> merchant
                gs = s["g"] - 50000
                s["g"] -= gs
                state["SuperSellin"]["g"] += gs
                pending_offload += gs
            if cls == "merchant":
                gr, pending_offload = pending_offload, 0
            s["hpp"] -= rnd.randint(0, 3) if fighting else 0
            s["mpp"] -= rnd.randint(0, 3) if fighting else 0
            share = {"warrior": 0.6, "ranger": 0.15, "priest": 0.25}.get(cls, 0)
            tk = int(rnd.uniform(3000, 9000) * share * 4) if fighting else 0
            mix = {"mummy": 0.55, "stoneworm": 0.3, "booboo": 0.15} if frac > 0.6 else {"snake": 0.7, "osnake": 0.3}
            tkm = {k: int(tk * v) for k, v in mix.items()} if tk else {}
            hr = int(rnd.uniform(800, 2500)) if fighting and cls != "priest" else 0
            km = {("stoneworm" if frac > 0.6 else "snake"): kb} if kb else {}
            row = {"t": t, "n": name, "c": cls, "lv": s["lv"], "xp": s["xp"], "mx": mx, "g": s["g"],
                   "hp": 4000, "mhp": 5000, "mp": 900, "mmp": 1500, "x": 600, "y": 100,
                   "m": "halloween" if frac < 0.8 else "spookytown", "md": mode, "tg": "snake" if fighting else None,
                   "dmg": dmg, "hl": hl, "kb": kb, "dt": 1 if rnd.random() < 0.003 else 0, "gs": gs, "gr": gr,
                   "hpp": s["hpp"], "mpp": s["mpp"], "tk": tk, "hr": hr, "tkm": tkm, "km": km,
                   "ping": rnd.randint(2, 6), "xpm": 2.35, "goldm": 1.35, "luckm": 1.24, "sv": "US III", "su": t - 4300000,
                   "bf": {"mluck": 3100, "encouragement_returning": 6000000}, "cc": round(rnd.uniform(5, 60), 1), "ccm": round(rnd.uniform(25, 150) if cls != "merchant" else rnd.uniform(8, 30), 1),
                   "eq": demo_gear.get(name, {}), "st": demo_stats.get(name, {})}
            if cls != "merchant":
                row["pd"] = int(dmg / 60 * rnd.uniform(0.9, 1.1))
                if rnd.random() < 0.01:
                    row["dr"] = {"statamulet" if rnd.random() < 0.6 else "hpamulet": 1}
            samples.append(row)
            if cls == "warrior" and rnd.random() < 0.004:
                events.append({"t": t, "n": name, "e": "death", "by": rnd.choice(["mummy", "booboo"]), "m": "spookytown", "x": 640, "y": 120})
            if cls != "merchant" and rnd.random() < 0.01:
                events.append({"t": t, "n": name, "e": "loot", "id": "c%d" % t, "g": rnd.randint(40, 300),
                               "items": [rnd.choice(["statamulet", "hpamulet", "dexbelt"])]})
        if rnd.random() < 0.02:
            item, unit = rnd.choice([("dexbelt", 400000), ("wshoes", 120000), ("phelmet", 206000), ("hpot1", 100)])
            q = rnd.randint(1, 3) if item == "hpot1" else 1
            trades.append({"t": t, "buyer": rnd.choice(["Bob", "Amy", "Kim", "Zed"]), "item": item,
                           "lv": rnd.randint(0, 6), "q": q, "unit": unit, "slot": "trade%d" % rnd.randint(1, 16)})
        t += 60000

    # A handful of synthetic upgrade attempts, spread over most slots, with slot 17 running hot
    # (matching the real ~102-105% relative effect) so the demo graphic has something to show.
    upgrades = []
    items = [("dexbelt", "cscroll0"), ("phelmet", "scroll0"), ("wshoes", "scroll1"), ("coat", "scroll0")]
    ut = start
    while ut < now:
        # slot 17 is over-represented so the demo grid actually surfaces a candidate slot
        slot = 17 if rnd.random() < 0.3 else rnd.randint(0, 41)
        item, scroll = rnd.choice(items)
        level = rnd.randint(0, 4)
        chance = round(rnd.uniform(0.15, 0.6), 3)
        base_roll = rnd.random()
        # mirrors the real server transform (node/server.js "16 cheat"); the demo also raises the
        # floor-hit rate on slot 17 well above reality (~1% there vs a lifelike chance well under
        # that) purely so the 00.00-roll clustering is visible without simulating tens of thousands
        # of attempts - the section's own footnote already says the real effect is much smaller
        boosted = slot == 17 and rnd.random() < 0.6
        if boosted and rnd.random() < 0.22:
            roll = rnd.uniform(0.0, 0.00003)
        else:
            roll = max(rnd.random() / 10000.0, base_roll * 0.975 - 0.012) if boosted else base_roll
        roll = min(0.999, max(0.0, roll))
        upgrades.append({"t": ut, "slot": slot, "item": item, "level": level, "scroll": scroll,
                         "chance": chance, "success": roll < chance, "roll": round(roll, 4)})
        ut += rnd.randint(20000, 180000)
    return samples, trades, events, upgrades


# ---------------------------------------------------------------- live receiver + dashboard server
def clean_row(r):
    if not isinstance(r, dict) or not isinstance(r.get("t"), (int, float)) or not isinstance(r.get("n"), str):
        return None
    out = {"t": r["t"], "n": r["n"][:32]}
    for k in NUM_KEYS:
        if isinstance(r.get(k), (int, float)) and not isinstance(r.get(k), bool):
            out[k] = r[k]
    for k in STR_KEYS:
        if isinstance(r.get(k), str):
            out[k] = r[k][:32]
    for k in MAP_KEYS:
        m = clean_map(r.get(k))
        if m:
            out[k] = m
    st = clean_stats(r.get("st"))
    if st:
        out["st"] = st
    eq = clean_equip(r.get("eq"))
    if eq:
        out["eq"] = eq
    return out


def clean_map(m):
    if not isinstance(m, dict):
        return None
    return {str(k)[:40]: v for k, v in list(m.items())[:12] if isinstance(v, (int, float)) and not isinstance(v, bool)}


def clean_stats(st):
    """Character stat sheet: unlike clean_map, keep every curated key (no 12-key cap) and one
    decimal of precision (crit/evasion/lifesteal etc. are often fractional)."""
    if not isinstance(st, dict):
        return None
    out = {}
    for k in STAT_KEYS:
        v = st.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            out[k] = round(v, 1)
    return out or None


def clean_equip(eq):
    if not isinstance(eq, dict):
        return None
    out = {}
    for slot in EQUIP_SLOTS:
        it = eq.get(slot)
        if not isinstance(it, dict) or not isinstance(it.get("n"), str):
            continue
        clean = {"n": it["n"][:24]}
        if isinstance(it.get("l"), (int, float)) and not isinstance(it.get("l"), bool):
            clean["l"] = int(it["l"])
        if isinstance(it.get("s"), str):
            clean["s"] = it["s"][:8]
        out[slot] = clean
    return out or None


def clean_event(e):
    """Notable events pushed by the game: death, loot, level up."""
    if not isinstance(e, dict) or not isinstance(e.get("t"), (int, float)) or not isinstance(e.get("e"), str):
        return None
    out = {"e": e["e"][:8], "t": e["t"]}
    for k in ("by", "m", "id"):
        if isinstance(e.get(k), str):
            out[k] = e[k][:40]
    for k in ("x", "y", "g", "lv"):
        if isinstance(e.get(k), (int, float)) and not isinstance(e.get(k), bool):
            out[k] = e[k]
    if isinstance(e.get("items"), list):
        out["items"] = [str(i)[:30] for i in e["items"][:8]]
    return out


def clean_trade(t):
    if not isinstance(t, dict) or not isinstance(t.get("t"), (int, float)):
        return None
    return {"t": t["t"], "buyer": str(t.get("buyer", ""))[:32], "item": str(t.get("item", ""))[:40],
            "lv": t.get("lv") if isinstance(t.get("lv"), (int, float)) else 0,
            "q": t.get("q") if isinstance(t.get("q"), (int, float)) else 1,
            "unit": t.get("unit") if isinstance(t.get("unit"), (int, float)) else 0, "slot": str(t.get("slot", ""))[:16]}


# The game permanently assigns each character one random inventory slot (0-41) at creation; a
# scroll-based upgrade attempted FROM that exact slot gets a small hidden roll bonus (confirmed by
# reading node/server.js: the "16 cheat" - never on compounds or offering-only attempts). Since the
# slot is fixed per character but unknown to us, we log every upgrade attempt (slot, shown chance,
# outcome) and let the dashboard find the slot whose actual success rate runs ahead of expected.
UPGRADE_SLOTS = 42


def clean_upgrade_row(r):
    if not isinstance(r, dict) or not isinstance(r.get("t"), (int, float)):
        return None
    slot = r.get("slot")
    if isinstance(slot, bool) or not isinstance(slot, (int, float)) or not (0 <= int(slot) < UPGRADE_SLOTS):
        return None
    out = {"t": r["t"], "slot": int(slot), "success": bool(r.get("success"))}
    if isinstance(r.get("level"), (int, float)) and not isinstance(r.get("level"), bool):
        out["level"] = int(r["level"])
    if isinstance(r.get("chance"), (int, float)) and not isinstance(r.get("chance"), bool):
        out["chance"] = max(0.0, min(1.0, float(r["chance"])))
    if isinstance(r.get("roll"), (int, float)) and not isinstance(r.get("roll"), bool):
        out["roll"] = max(0.0, min(1.0, float(r["roll"])))
    for k in ("item", "scroll", "offering"):
        if isinstance(r.get(k), str):
            out[k] = r[k][:32]
    return out


# Same thresholds the community "Lucky Slot Tracker" (Crown) uses on the decoded roll: an exact
# 00.00 reveal (all four decimal digits zero) versus a roll above 96.3%.
ROLL_ZERO_MAX = 0.00005   # roll < this counts as a "00.00" (the boosted-roll floor branch always lands here)
ROLL_HIGH_MIN = 0.963


def upgrade_slot_stats(rows):
    """Per-slot (0-41): attempt count, summed shown chance, actual successes, and (when the decoded
    roll got through) zero/high roll counts - the same win-rate-vs-expected and roll-bucket signals
    the community tool uses, kept per slot so either can point at the same candidate. Offering-only
    attempts (no scroll) are excluded: the slot bonus never applies to them, so mixing them in would
    only dilute the signal."""
    slots = [{"slot": i, "n": 0, "expected": 0.0, "actual": 0, "rolls": 0, "zero": 0, "high": 0}
             for i in range(UPGRADE_SLOTS)]
    for r in rows:
        if not r.get("scroll"):
            continue
        i = r.get("slot")
        if not isinstance(i, int) or not (0 <= i < UPGRADE_SLOTS):
            continue
        b = slots[i]
        b["n"] += 1
        if isinstance(r.get("chance"), (int, float)):
            b["expected"] += r["chance"]
        if r.get("success"):
            b["actual"] += 1
        roll = r.get("roll")
        if isinstance(roll, (int, float)):
            b["rolls"] += 1
            if roll < ROLL_ZERO_MAX:
                b["zero"] += 1
            elif roll > ROLL_HIGH_MIN:
                b["high"] += 1
    for b in slots:
        b["expected"] = round(b["expected"], 2)
        b["relative"] = round(100.0 * b["actual"] / b["expected"], 1) if b["expected"] > 0 else None
    return slots


class LiveState:
    KEEP_MS = 7 * 86400 * 1000
    MAX_FILE = 40 * 1024 * 1024

    def __init__(self, data_dir):
        self.data_dir = data_dir
        os.makedirs(data_dir, exist_ok=True)
        self.lock = threading.RLock()
        self.live_path = os.path.join(data_dir, "live.jsonl")
        self.trades_path = os.path.join(data_dir, "trades.jsonl")
        self.events_path = os.path.join(data_dir, "events.jsonl")
        self.upgrades_path = os.path.join(data_dir, "upgrades.jsonl")
        self.upgrades = load_jsonl(self.upgrades_path)
        self.cond = threading.Condition()
        self.version = 0
        self.events = load_jsonl(self.events_path)[-500:]
        self.event_ids = {e["id"] for e in self.events if e.get("id")}
        self.live = defaultdict(list)
        self.trades = []
        self.trade_keys = set()
        self.cache = {}
        self.pushed = Counter()
        cutoff = int(time.time() * 1000) - self.KEEP_MS
        rows = [r for r in load_jsonl(self.live_path) if isinstance(r.get("t"), (int, float)) and r["t"] >= cutoff]
        if os.path.exists(self.live_path) and os.path.getsize(self.live_path) > self.MAX_FILE:
            with open(self.live_path, "w", encoding="utf-8") as f:
                for r in rows:
                    f.write(json.dumps(r, separators=(",", ":")) + "\n")
        for r in sorted(rows, key=lambda r: r["t"]):
            self.live[r["n"]].append(r)
        for t in load_jsonl(self.trades_path):
            if trade_key(t) not in self.trade_keys:
                self.trade_keys.add(trade_key(t))
                self.trades.append(t)

    def notify(self):
        with self.cond:
            self.version += 1
            self.cond.notify_all()

    def add_row(self, row):
        with self.lock:
            self.live[row["n"]].append(row)
            self.pushed[row["n"]] += 1
            append_jsonl(self.live_path, [row])
        self.notify()

    def add_event(self, name, ev):
        """Store a notable event. Every party member sees the same chest, so loot is deduped by chest id."""
        with self.lock:
            if ev["e"] == "loot" and ev.get("id"):
                if ev["id"] in self.event_ids:
                    return False
                self.event_ids.add(ev["id"])
            ev = dict(ev, n=name)
            self.events.append(ev)
            del self.events[:-500]
            append_jsonl(self.events_path, [ev])
            self.cache.clear()
        self.notify()
        return True

    def stream_payload(self):
        with self.lock:
            return {"now": [rs[-1] for rs in self.live.values() if rs], "events": self.events[-40:],
                    "server": int(time.time() * 1000)}

    def add_trade(self, trade):
        with self.lock:
            if trade_key(trade) in self.trade_keys:
                return False
            self.trade_keys.add(trade_key(trade))
            self.trades.append(trade)
            append_jsonl(self.trades_path, [trade])
            self.cache.clear()
        self.notify()
        return True

    def add_upgrade(self, row):
        with self.lock:
            self.upgrades.append(row)
            append_jsonl(self.upgrades_path, [row])
            self.cache.clear()
        self.notify()

    def data(self, range_key, title="Adventure Land farm dashboard (LIVE)"):
        window, bucket_ms = RANGES.get(range_key, RANGES["6h"])
        now = int(time.time() * 1000)
        hit = self.cache.get(range_key)
        if hit and now - hit[0] < 2000:
            return hit[1]
        cutoff = now - window if window else 0
        with self.lock:
            rows = [r for rows in self.live.values() for r in rows if r["t"] >= cutoff]
            trades = [t for t in self.trades if t["t"] >= cutoff]
            now_rows = [rs[-1] for rs in self.live.values() if rs]
            events = [e for e in self.events if e.get("t", 0) >= cutoff][-200:]
        data = build_data(rows, trades, int(bucket_ms), title, now_rows, events)
        with self.lock:
            data["upgradeSlots"] = upgrade_slot_stats(self.upgrades)
        self.cache[range_key] = (now, data)
        return data


def ensure_secret(data_dir):
    path = os.path.join(data_dir, "live_secret.txt")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            val = f.read().strip()
        if val:
            return val
    os.makedirs(data_dir, exist_ok=True)
    val = secrets.token_urlsafe(24)
    with open(path, "w", encoding="utf-8") as f:
        f.write(val + "\n")
    return val


def ensure_live_config(port, secret):
    """Write the (gitignored) slot file the game loads to learn the receiver url + secret."""
    folder = os.path.join(ROOT, "adventureland", "codes")
    if not os.path.isdir(folder):
        return None
    path = os.path.join(folder, "LiveConfig.%d.js" % LIVE_SLOT)
    body = ("// Generated by tools/telemetry_dashboard.py --serve. Private: never commit or share.\n"
            "var LIVE_CONFIG = %s;\n" % json.dumps({"url": "http://127.0.0.1:%d" % port, "secret": secret}))
    try:
        with open(path, encoding="utf-8") as f:
            if f.read() == body:
                return path
    except OSError:
        pass
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)
    return path


def run_server(port, origins, secret, state):
    stats = {"rejected": Counter(), "bad": 0, "last_report": time.time()}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _host_ok(self):
            return (self.headers.get("Host") or "") in ("127.0.0.1:%d" % port, "localhost:%d" % port)

        def _cors(self, origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-AL-Key")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Vary", "Origin")

        def _send(self, code, body=b"", ctype="text/plain; charset=utf-8", origin=None):
            self.send_response(code)
            if origin:
                self._cors(origin)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if body:
                self.wfile.write(body)

        def do_OPTIONS(self):
            origin = self.headers.get("Origin")
            if urlparse(self.path).path == "/live" and origin in origins:
                self._send(204, origin=origin)
            else:
                stats["rejected"][str(origin)] += 1
                self._send(403)

        def do_GET(self):
            if not self._host_ok():
                return self._send(403)
            u = urlparse(self.path)
            if u.path == "/":
                page = render_page(state.data("6h"), "/api/data")
                return self._send(200, page.encode("utf-8"), "text/html; charset=utf-8")
            if u.path == "/api/data":
                rk = (parse_qs(u.query).get("range") or ["6h"])[0]
                blob = json.dumps(state.data(rk), separators=(",", ":")).encode("utf-8")
                return self._send(200, blob, "application/json")
            if u.path == "/api/stream":
                return self._stream()
            if u.path == "/health":
                return self._send(200, b"ok")
            self._send(404)

        def _stream(self):
            """Server-sent events: one small message whenever a push arrives (bursts coalesced to ~4/s)."""
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            last = -1
            try:
                while True:
                    with state.cond:
                        state.cond.wait_for(lambda: state.version != last, timeout=15)
                        changed = state.version != last
                        last = state.version
                    if changed:
                        blob = json.dumps(state.stream_payload(), separators=(",", ":"))
                        self.wfile.write(("data: %s\n\n" % blob).encode("utf-8"))
                        self.wfile.flush()
                        time.sleep(0.25)
                    else:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
            except OSError:
                pass  # the browser tab closed

        def do_POST(self):
            if urlparse(self.path).path != "/live" or not self._host_ok():
                return self._send(404)
            origin = self.headers.get("Origin")
            if origin not in origins:
                stats["rejected"][str(origin)] += 1
                return self._send(403)
            if not hmac.compare_digest(self.headers.get("X-AL-Key") or "", secret):
                stats["bad"] += 1
                return self._send(401, origin=origin)
            try:
                n = min(int(self.headers.get("Content-Length") or 0), 16 * 1024)
                msg = json.loads(self.rfile.read(n).decode("utf-8"))
            except (ValueError, OSError):
                return self._send(400, origin=origin)
            now = int(time.time() * 1000)
            if isinstance(msg, dict) and msg.get("k") == "s":
                row = clean_row(msg.get("row"))
                if row and abs(row["t"] - now) < 5 * 60 * 1000:
                    state.add_row(row)
                    for raw in (msg.get("ev") if isinstance(msg.get("ev"), list) else [])[:20]:
                        ev = clean_event(raw)
                        if ev and abs(ev["t"] - now) < 5 * 60 * 1000:
                            state.add_event(row["n"], ev)
            elif isinstance(msg, dict) and msg.get("k") == "sale":
                trade = clean_trade(msg.get("trade"))
                if trade and abs(trade["t"] - now) < 5 * 60 * 1000 and state.add_trade(trade):
                    print("%s  SALE  %s x%s%s to %s @ %s" % (time.strftime("%H:%M:%S"), trade["item"], trade["q"],
                          " +%s" % trade["lv"] if trade["lv"] else "", trade["buyer"], trade["unit"]), flush=True)
            elif isinstance(msg, dict) and msg.get("k") == "upgrade":
                row = clean_upgrade_row(msg.get("row"))
                if row and abs(row["t"] - now) < 5 * 60 * 1000:
                    state.add_upgrade(row)
                    print("%s  UPGRADE  slot %d  %s%s  chance %s -> %s" % (
                        time.strftime("%H:%M:%S"), row["slot"], row.get("item", "?"),
                        " +%s" % row["level"] if row.get("level") else "",
                        ("%.0f%%" % (row["chance"] * 100)) if "chance" in row else "?",
                        "SUCCESS" if row["success"] else "fail"), flush=True)
            self._send(204, origin=origin)

    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True

    def background():
        while True:
            time.sleep(20)
            if time.time() - stats["last_report"] >= 30:
                stats["last_report"] = time.time()
                seen = ", ".join("%s:%d" % kv for kv in sorted(state.pushed.items())) or "none yet"
                extra = ""
                if stats["rejected"]:
                    extra += "  rejected origins: %s" % dict(stats["rejected"])
                if stats["bad"]:
                    extra += "  wrong-secret requests: %d" % stats["bad"]
                print("%s  pushes received (since start): %s%s" % (time.strftime("%H:%M:%S"), seen, extra), flush=True)

    threading.Thread(target=background, daemon=True).start()
    print("LIVE dashboard: http://127.0.0.1:%d/   (loopback only, Ctrl+C to stop)" % port, flush=True)
    print("Accepting pushes from: %s" % ", ".join(sorted(origins)), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--watch", nargs="?", const=60, type=int, metavar="SECONDS", help="rebuild repeatedly")
    ap.add_argument("--demo", action="store_true", help="write dashboard/demo.html from synthetic data")
    ap.add_argument("--serve", nargs="?", const=8765, type=int, metavar="PORT", help="live receiver + dashboard server")
    ap.add_argument("--data-dir", metavar="PATH", help="testing only: use this folder instead of data/ (also skips writing LiveConfig)")
    ap.add_argument("--allow-origin", action="append", default=[], metavar="ORIGIN",
                    help="extra origin allowed to push (default: https://adventure.land)")
    args = ap.parse_args()

    if args.serve:
        data_dir = args.data_dir or os.path.join(ROOT, "data")
        secret = ensure_secret(data_dir)
        cfg = None if args.data_dir else ensure_live_config(args.serve, secret)
        if cfg:
            print("Game-side config: %s (a private slot; the VS Code sync uploads it as slot %d)" % (os.path.relpath(cfg, ROOT), LIVE_SLOT))
        elif not args.data_dir:
            print("No adventureland/codes folder here: create LiveConfig.%d.js yourself (see codes/LiveConfig.example.js)" % LIVE_SLOT)
        state = LiveState(data_dir)
        run_server(args.serve, set(DEFAULT_ORIGINS) | set(args.allow_origin), secret, state)
        return

    if args.demo:
        samples, trades, events, upgrades = make_demo()
        n = build_dashboard(samples, trades, os.path.join(ROOT, "dashboard", "demo.html"), "DEMO data (synthetic)", events, upgrades)
        print("demo dashboard: %d buckets -> dashboard/demo.html" % n)
        return

    def run():
        data_dir = os.path.join(ROOT, "data")
        samples = load_jsonl(os.path.join(data_dir, "live.jsonl"))
        trades = load_jsonl(os.path.join(data_dir, "trades.jsonl"))
        events = load_jsonl(os.path.join(data_dir, "events.jsonl"))[-200:]
        upgrades = load_jsonl(os.path.join(data_dir, "upgrades.jsonl"))
        if not samples:
            print("no data/live.jsonl yet (run --serve while CODE is running to start recording)")
        n = build_dashboard(samples, trades, os.path.join(ROOT, "dashboard", "index.html"), events=events, upgrades=upgrades)
        print("%s  %d samples, %d buckets, %d sales, %d upgrade attempts -> dashboard/index.html"
              % (time.strftime("%H:%M:%S"), len(samples), n, len(trades), len(upgrades)))

    run()
    while args.watch:
        try:
            time.sleep(args.watch)
        except KeyboardInterrupt:
            break
        run()


if __name__ == "__main__":
    sys.exit(main())
