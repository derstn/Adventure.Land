// --- SHARED: TELEMETRY (farm metrics, live event push, merchant sales log) ---
// Account CODE slot, loaded via load_code("Telemetry") from every character script, after
// PartyManager and (optionally) LiveConfig. It starts timers and event listeners when loaded,
// so load it exactly once per CODE run and do NOT hot-reload it. Top-level bindings are `var`.
//
// Live only: if a LIVE_CONFIG slot defines a url + secret, the game's own events (hit taken,
// hit dealt / kill, loot, death, level up, sale, merchant upgrade attempts) trigger a push to a
// receiver on this computer (py tools/telemetry_dashboard.py --serve). Bursts are coalesced into
// at most one message per liveFlushMs per character, and an idle character sends a small
// heartbeat. No config or no receiver = nothing is sent, and nothing else runs (no polling, no
// CODE-slot storage).
//
// Gold: gold moved between our own characters (merchant patrol offloading, etc.) is counted separately
// (gs = sent to own characters, gr = received from own characters) so the dashboard can exclude it and
// never counts the same gold twice.
var TELEMETRY_CONFIG = {
    liveFlushMs: 500,                   // events are coalesced: at most one live message per character per this long
    liveHeartbeatMs: 15 * 1000,         // how often to check whether an idle character should send a heartbeat
    liveIdleBeforeHeartbeatMs: 12 * 1000,
    liveFailsBeforeBackoff: 3,          // receiver not running: slow down instead of hammering it
    liveBackoffMs: 60 * 1000,
    maxMapKeys: 12
};

var telemetryIsMerchant = character.ctype === "merchant";
var telemetryOwn = (typeof PARTY_CONFIG !== "undefined" ? PARTY_CONFIG.members : []).concat(["DerstnMage"]);
var telemetryStartedAt = Date.now(); // session start, for the dashboard's uptime

function telemetryBlankWindow() {
    return { dmg: 0, heal: 0, kb: 0, deaths: 0, gs: 0, gr: 0, tk: 0, hr: 0, tkm: {}, km: {}, drops: {} };
}
var telemetryLiveWindow = telemetryBlankWindow();  // counters since the last live message
var telemetryEventQueue = [];  // notable events (death, loot, level up) waiting for the next live message
var telemetryLastHit = null;   // { mt, t }: who hurt us last, for death context
var telemetryFlushTimer = null;
var telemetryLastFlushAt = 0;
var telemetrySlotCache = {};   // merchant only: last seen trade-slot listings
var telemetryLiveFails = 0;
var telemetryLiveNextAt = 0;
var telemetryCcMax = 0;         // peak server call cost seen since the last live flush (limit: 200)

function telemetryBump(key, n) {
    telemetryLiveWindow[key] += n;
}

function telemetryBumpMap(key, name, n) {
    if (!name) return;
    telemetryLiveWindow[key][name] = (telemetryLiveWindow[key][name] || 0) + n;
}

function telemetryBumpDrop(name, n) {
    telemetryLiveWindow.drops[name] = (telemetryLiveWindow.drops[name] || 0) + n;
}

// Monster type for an entity id (a monster that hit us or that we just killed), if still visible.
function telemetryMtype(id) {
    let e = parent.entities && parent.entities[id];
    return e && e.type === "monster" && typeof e.mtype === "string" ? e.mtype.slice(0, 24) : null;
}

// Server call cost (the game disconnects a character above 200). Read from the character, falling back to the game frame.
var telemetryCcNulls = 0;
function telemetryCc() {
    let v = character.cc;
    if (typeof v !== "number" && typeof parent !== "undefined" && parent.character) v = parent.character.cc;
    return typeof v === "number" && isFinite(v) ? v : null;
}

// Long-lasting buffs (mluck, encouragement, ...) as name -> seconds remaining; short combat debuffs are skipped.
function telemetryBuffs() {
    let out = {};
    let s = character.s || {};
    for (let name of Object.keys(s)) {
        let ms = s[name] && s[name].ms;
        if (typeof ms === "number" && ms >= 60000) out[name.slice(0, 30)] = Math.round(ms / 1000);
    }
    return out;
}

function telemetryPotionCount(prefix) {
    let total = 0;
    for (let it of character.items || []) {
        if (it && typeof it.name === "string" && it.name.indexOf(prefix) === 0) total += it.q || 1;
    }
    return total;
}

function telemetryPartyDps() {
    let party = get_party();
    let me = party && party[character.name];
    return me && typeof me.pdps === "number" ? Math.round(me.pdps) : null;
}

// Equipped gear, one entry per occupied slot: { n: item name, l: level, s?: stat_type }.
// Slot keys and item shape are exactly the documented character.slots contract (data-character.md).
var TELEMETRY_EQUIP_SLOTS = ["mainhand", "offhand", "helmet", "chest", "pants", "shoes", "gloves",
    "cape", "belt", "ring1", "ring2", "earring1", "earring2", "amulet", "orb"];
function telemetryEquip() {
    let out = {};
    let slots = character.slots || {};
    for (let key of TELEMETRY_EQUIP_SLOTS) {
        let it = slots[key];
        if (!it || typeof it.name !== "string") continue;
        let entry = { n: it.name.slice(0, 24), l: it.level || 0 };
        if (typeof it.stat_type === "string") entry.s = it.stat_type.slice(0, 8);
        out[key] = entry;
    }
    return out;
}

// Documented combat-relevant character fields (data-character.md); social/PVP-only fields
// (for, courage, mcourage, pcourage, fear, targets) are left out as not useful for a gear sheet.
function telemetryStats() {
    return {
        str: character.str, int: character.int, dex: character.dex, vit: character.vit,
        attack: character.attack, frequency: character.frequency, speed: character.speed, range: character.range,
        armor: character.armor, resistance: character.resistance,
        apiercing: character.apiercing, rpiercing: character.rpiercing,
        evasion: character.evasion, reflection: character.reflection, crit: character.crit,
        lifesteal: character.lifesteal, manasteal: character.manasteal, dreturn: character.dreturn,
        mp_cost: character.mp_cost
    };
}

// Gear-up spend visibility (SuperSellin only). Telemetry.js is shared by every character, but
// gear-up's state (GEARUP_CONFIG, gearupSpendLog, etc.) only exists where supersellin.js defines it -
// checked defensively so this is a no-op everywhere else. Reports the rolling-hour spend total, the
// configured cap, what's currently blocking further spend (0 if nothing), the active item and its
// progress, and the oldest still-counted ledger entry's timestamp so the dashboard can show roughly
// when headroom next opens up (the exact moment depends on how many more entries age out after that
// one, but the oldest is the first and usually the most informative point).
function telemetryGearup() {
    if (typeof GEARUP_CONFIG === "undefined" || typeof gearupSpendLog === "undefined" || typeof gearupRecentSpend !== "function") return null;
    let activeItem = typeof gearupActiveItem === "function" ? gearupActiveItem() : null;
    let oldest = gearupSpendLog.length ? Math.min.apply(null, gearupSpendLog.map(e => e.t)) : null;
    return {
        spend: gearupRecentSpend(),
        cap: GEARUP_CONFIG.maxSpendPerHour,
        blocked: (typeof gearupBlockedCost === "number" && gearupBlockedCost) || 0,
        item: activeItem,
        banked: activeItem && typeof gearupBanked !== "undefined" ? (gearupBanked[activeItem] || 0) : 0,
        need: GEARUP_CONFIG.copiesPerItem,
        oldest: oldest,
        // Per-climb cost breakdown (how many items/scrolls/gold it actually took for each +9, not just
        // the aggregate rolling-hour cap): the in-progress climb's running totals, plus the last 10
        // finished climbs, newest last.
        climb: typeof gearupClimb !== "undefined" ? gearupClimb : null,
        history: typeof gearupHistory !== "undefined" ? gearupHistory.slice(-10) : []
    };
}

// Active cosmetics (character.cx) - dashboard character-portrait rendering. Despite data-character.md's
// doc example showing a flat array (cx: ["santahat"]), real live data confirmed this session (captured
// from the official /player/<name> page's own data-cx attributes, e.g. {"hair":"hairdo206"}) is a
// place-keyed OBJECT whenever more than a single slot is active - {"hair":"...", "head":"...", ...}.
// The array form may still occur (the doc isn't fabricated, just possibly a simplified single-item
// case), so both shapes are accepted here rather than assuming one. An earlier version of this
// function only accepted the array shape and silently discarded every real character's cx as a
// result - confirmed by fetching this account's own live telemetry and finding cx: null everywhere
// despite every character visibly having hair/hat cosmetics equipped.
function telemetryCleanCx(cx) {
    if (Array.isArray(cx)) {
        let out = cx.filter(c => typeof c === "string" && c).slice(0, 8).map(c => c.slice(0, 24));
        return out.length ? out : null;
    }
    if (cx && typeof cx === "object") {
        let out = {};
        for (let place of Object.keys(cx).slice(0, 12)) {
            if (typeof cx[place] === "string" && cx[place]) out[place.slice(0, 16)] = cx[place].slice(0, 24);
        }
        return Object.keys(out).length ? out : null;
    }
    return null;
}

// name -> number maps (drops, damage taken by monster type, kills by monster type)
function telemetryCleanMap(m) {
    if (!m || typeof m !== "object") return null;
    let out = {};
    for (let name of Object.keys(m).slice(0, TELEMETRY_CONFIG.maxMapKeys)) {
        if (typeof m[name] === "number" && isFinite(m[name])) out[name.slice(0, 40)] = Math.round(m[name]);
    }
    return Object.keys(out).length ? out : null;
}

// Character stat sheet: unlike telemetryCleanMap's name->number maps (drops, damage by monster type,
// capped at maxMapKeys=12 and rounded to whole numbers), stats need every key kept (18, all curated,
// none untrusted) and one decimal of precision (crit/evasion/lifesteal etc. are often fractional).
function telemetryCleanStats(st) {
    if (!st || typeof st !== "object") return null;
    let out = {};
    for (let name of Object.keys(st)) {
        if (typeof st[name] === "number" && isFinite(st[name])) out[name] = Math.round(st[name] * 10) / 10;
    }
    return Object.keys(out).length ? out : null;
}

// name -> {n, l, s?} equipment slots (see telemetryEquip).
function telemetryCleanEquip(eq) {
    if (!eq || typeof eq !== "object") return null;
    let out = {};
    for (let key of TELEMETRY_EQUIP_SLOTS) {
        let it = eq[key];
        if (!it || typeof it !== "object" || typeof it.n !== "string") continue;
        let entry = { n: it.n.slice(0, 24) };
        if (typeof it.l === "number" && isFinite(it.l)) entry.l = Math.round(it.l);
        if (typeof it.s === "string") entry.s = it.s.slice(0, 8);
        out[key] = entry;
    }
    return Object.keys(out).length ? out : null;
}

// One climb record: {item, gold, items, attempts, startedAt, finishedAt?} numbers/strings + a
// scrolls name->qty map (see gearupClimb/gearupHistory in supersellin.js).
function telemetryCleanClimb(c) {
    if (!c || typeof c !== "object" || typeof c.item !== "string") return null;
    let out = { item: c.item.slice(0, 24) };
    for (let k of ["gold", "items", "attempts", "startedAt", "finishedAt"]) {
        if (typeof c[k] === "number" && isFinite(c[k])) out[k] = Math.round(c[k]);
    }
    if (c.scrolls && typeof c.scrolls === "object") {
        let scrolls = {};
        for (let name of Object.keys(c.scrolls).slice(0, 8)) {
            if (typeof c.scrolls[name] === "number" && isFinite(c.scrolls[name])) scrolls[name.slice(0, 16)] = Math.round(c.scrolls[name]);
        }
        if (Object.keys(scrolls).length) out.scrolls = scrolls;
    }
    return out;
}

// {spend, cap, blocked, banked, need, oldest} numbers + {item} string + {climb, history} (see telemetryGearup).
function telemetryCleanGearup(gu) {
    if (!gu || typeof gu !== "object") return null;
    let out = {};
    for (let k of ["spend", "cap", "blocked", "banked", "need", "oldest"]) {
        if (typeof gu[k] === "number" && isFinite(gu[k])) out[k] = Math.round(gu[k]);
    }
    if (typeof gu.item === "string") out.item = gu.item.slice(0, 24);
    let climb = telemetryCleanClimb(gu.climb);
    if (climb) out.climb = climb;
    if (Array.isArray(gu.history)) {
        let history = gu.history.map(telemetryCleanClimb).filter(Boolean).slice(0, 10);
        if (history.length) out.history = history;
    }
    return Object.keys(out).length ? out : null;
}

// Keep only known fields of the expected type before this character's own row is sent out.
function telemetryCleanRow(r) {
    if (!r || typeof r !== "object" || typeof r.t !== "number" || typeof r.n !== "string") return null;
    let out = { t: r.t, n: r.n.slice(0, 32) };
    for (let k of ["lv", "xp", "mx", "g", "hp", "mhp", "mp", "mmp", "pd", "dmg", "hl", "kb", "dt", "gs", "gr", "tk", "hr", "hpp", "mpp", "x", "y", "cc", "ccm", "ping", "xpm", "goldm", "luckm", "su"]) {
        if (typeof r[k] === "number" && isFinite(r[k])) out[k] = r[k];
    }
    for (let k of ["c", "m", "md", "tg", "sv", "skin"]) {
        if (typeof r[k] === "string") out[k] = r[k].slice(0, 32);
    }
    for (let k of ["dr", "tkm", "km", "bf"]) {
        let m = telemetryCleanMap(r[k]);
        if (m) out[k] = m;
    }
    let cx = telemetryCleanCx(r.cx);
    if (cx) out.cx = cx;
    let st = telemetryCleanStats(r.st);
    if (st) out.st = st;
    let eq = telemetryCleanEquip(r.eq);
    if (eq) out.eq = eq;
    let gu = telemetryCleanGearup(r.gu);
    if (gu) out.gu = gu;
    return out;
}

function telemetryBuildRow(w) {
    let target = get_targeted_monster();
    let row = {
        t: Date.now(), n: character.name, c: character.ctype, lv: character.level,
        xp: character.xp, mx: character.max_xp, g: character.gold,
        hp: character.hp, mhp: character.max_hp, mp: character.mp, mmp: character.max_mp,
        m: character.map, x: Math.round(character.x), y: Math.round(character.y),
        md: typeof FARM_CONFIG !== "undefined" ? FARM_CONFIG.mode : null,
        tg: target ? target.mtype : null,
        pd: telemetryPartyDps(),
        dmg: Math.round(w.dmg), hl: Math.round(w.heal), kb: w.kb, dt: w.deaths, gs: w.gs, gr: w.gr,
        tk: Math.round(w.tk), hr: Math.round(w.hr), tkm: w.tkm, km: w.km, dr: w.drops,
        hpp: telemetryPotionCount("hpot"), mpp: telemetryPotionCount("mpot"),
        cc: telemetryCc() === null ? null : Math.round(telemetryCc() * 10) / 10,
        ccm: telemetryCcMax > 0 ? Math.round(telemetryCcMax * 10) / 10 : null,
        ping: typeof character.ping === "number" ? Math.round(character.ping) : null,
        xpm: character.xpm, goldm: character.goldm, luckm: character.luckm,
        sv: server.region + " " + server.id, su: telemetryStartedAt,
        bf: telemetryBuffs(), eq: telemetryEquip(), st: telemetryStats(), gu: telemetryGearup(),
        // Dashboard character-portrait rendering (hotlinked from adventure.land's own data.js/image
        // URLs - see adventureland_respect_game_art.md): both plain documented character fields
        // (data-character.md), just never previously sent. Live "now" state only, same as eq/st -
        // no need to bucket a cosmetic loadout over time.
        skin: typeof character.skin === "string" ? character.skin : null,
        cx: character.cx // shape (array or place-keyed object) validated by telemetryCleanCx below, not here
    };
    return telemetryCleanRow(row);
}

// --- live push (optional, event-driven) ---
function telemetryLiveEnabled() {
    return typeof LIVE_CONFIG !== "undefined" && !!LIVE_CONFIG && !!LIVE_CONFIG.url && !!LIVE_CONFIG.secret && typeof fetch === "function";
}

function telemetryLiveFailed() {
    telemetryLiveFails++;
    if (telemetryLiveFails >= TELEMETRY_CONFIG.liveFailsBeforeBackoff) {
        telemetryLiveNextAt = Date.now() + TELEMETRY_CONFIG.liveBackoffMs;
    }
}

function telemetryLivePush(msg, force) {
    if (!telemetryLiveEnabled()) return;
    if (!force && Date.now() < telemetryLiveNextAt) return;
    fetch(LIVE_CONFIG.url + "/live", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AL-Key": LIVE_CONFIG.secret },
        body: JSON.stringify(msg)
    }).then(function (res) {
        if (res.ok) telemetryLiveFails = 0;
        else telemetryLiveFailed();
    }).catch(telemetryLiveFailed);
}

// Send the current state + counters + queued events now.
function telemetryLiveFlush() {
    telemetryLastFlushAt = Date.now();
    let w = telemetryLiveWindow;
    telemetryLiveWindow = telemetryBlankWindow();
    telemetryCcMax = telemetryCc() || 0;
    let events = telemetryEventQueue;
    telemetryEventQueue = [];
    let row = telemetryBuildRow(w);
    if (!row) return;
    let msg = { k: "s", row: row };
    if (events.length) msg.ev = events;
    telemetryLivePush(msg);
}

// Something happened: send within liveFlushMs. A burst of events shares one message.
function telemetryScheduleFlush() {
    if (telemetryFlushTimer || !telemetryLiveEnabled()) return;
    telemetryFlushTimer = setTimeout(function () {
        telemetryFlushTimer = null;
        telemetryLiveFlush();
    }, TELEMETRY_CONFIG.liveFlushMs);
}

function telemetryHeartbeat() {
    if (!telemetryLiveEnabled()) return;
    if (Date.now() - telemetryLastFlushAt >= TELEMETRY_CONFIG.liveIdleBeforeHeartbeatMs) telemetryLiveFlush();
}

function telemetryPushEvent(ev) {
    ev.t = Date.now();
    if (telemetryEventQueue.length < 30) telemetryEventQueue.push(ev);
    telemetryScheduleFlush();
}

// --- bank pack snapshots (merchant only, dashboard "Bank" panel) ---
// character.bank exists only while physically inside the bank (banking.md) and holds shared gold plus
// every pack open on that floor - dynamic, so this iterates whatever keys are actually present rather
// than hardcoding "items0".."itemsN" (the account can open more packs over time). Each pack is 42
// slots, same shape as character.items (banking.md's own bank_store/bank_retrieve examples). Call this
// right after arriving at the bank, while character.bank is populated - it does not travel there
// itself, it only piggybacks on trips gear-up/exchange-overflow already make (see supersellin.js), so
// freshness is bounded by how often those already run.
function telemetrySnapshotBank() {
    if (!telemetryIsMerchant || !character.bank) return;
    let packs = {};
    for (let name of Object.keys(character.bank)) {
        if (name === "gold") continue;
        let pack = character.bank[name];
        if (!Array.isArray(pack)) continue;
        let slots = [];
        for (let i = 0; i < 42; i++) {
            let it = pack[i];
            slots.push(it && typeof it.name === "string" ? { n: it.name.slice(0, 24), l: it.level || 0, q: it.q || 1 } : null);
        }
        packs[name.slice(0, 16)] = slots;
    }
    if (Object.keys(packs).length) telemetryLivePush({ k: "bank", row: { t: Date.now(), packs: packs } }, true);
}

// --- merchant sales ---
function telemetrySnapshotSlots() {
    let out = {};
    for (let i = 1; i <= 16; i++) {
        let key = "trade" + i;
        let s = character.slots && character.slots[key];
        if (s && s.name && !s.b) out[key] = { name: s.name, level: s.level || 0, q: s.q || 1, price: s.price || 0 };
    }
    return out;
}

function telemetryOnSale(d) {
    if (!telemetryIsMerchant || !d || !d.item) return;
    let before = telemetrySlotCache[d.slot] || null;
    let after = telemetrySnapshotSlots()[d.slot] || null;
    let remaining = before && after && after.name === before.name ? after.q : 0;
    let qty = before ? Math.max(1, before.q - remaining) : 1;
    let trade = {
        t: Date.now(), buyer: String(d.buyer || "").slice(0, 32), item: String(d.item.name || "").slice(0, 40),
        lv: d.item.level || 0, q: qty, unit: before ? before.price : 0, slot: String(d.slot || "")
    };
    telemetrySlotCache = telemetrySnapshotSlots();
    telemetryLivePush({ k: "sale", trade: trade }, true);
}

// --- merchant upgrade-slot tracking ("lucky slot" research) ---
// The game permanently assigns each character one random inventory slot (0-41) at creation
// (server_functions.js: player.p.item_num = parseInt(Math.random()*42)). Upgrading a scroll-based
// item FROM that exact slot has a 60% chance per attempt of a small roll bonus (node/server.js
// "16 cheat": result = max(Math.random()/10000, result*0.975-0.012), never on compounds/offerings-only).
// We can't read player.p.item_num directly, so we log every attempt (slot, shown chance, outcome) and
// let the dashboard find the slot whose actual success rate runs ahead of its expected rate.
//
// Detection is poll-only (character.q + character.items), NOT character.on("upgrade_success"/"fail").
// Those look like the natural event names, but reading js/game.js's game_response handler shows
// character events only fire when the server message carries a "cevent" field, and node/server.js's
// upgrade_success/upgrade_fail pushes (~L14651, L14669) never set one - so those events never reach
// CODE at all. character.q.upgrade and character.items are both plain documented character fields,
// so this works regardless.
var telemetryUpgradePending = null; // { slot, chance, item, level, scroll, offering, roll } for the in-flight attempt
var telemetryUpgradeResolveAt = 0;  // 0 = not yet waiting to read the outcome; else the earliest time it's safe to read it

// Runs every 200ms (a local property read, not a server call). Catches an attempt's shown chance the
// moment it starts (character.q.upgrade appears), then reads the outcome off character.items after a
// short grace period once it ends (character.q.upgrade disappears again).
//
// The grace period is required, not optional: the data-character doc explicitly warns "Character
// updates are live but asynchronous. A Promise result and the next character update can arrive
// separately" - q.upgrade clearing and character.items[slot] actually reflecting the outcome are two
// separate local state updates with no guarantee they land in the same tick. Reading immediately (the
// original design) intermittently read character.items before it had caught up, misreporting real
// successes as failures - confirmed by a real gear-up log where the item kept climbing through
// several "fail"-labeled attempts, and reproduced directly in a headless-Chrome test that injects an
// artificial gap between the two updates (see adventureland_project.md). ~400ms (2 poll cycles) is a
// generous, cheap allowance for a same-client local update lag.
var TELEMETRY_UPGRADE_RESOLVE_GRACE_MS = 400;

function telemetryCheckUpgrade() {
    let q = character.q && character.q.upgrade;
    if (q && typeof q.num === "number") {
        if (telemetryUpgradePending && telemetryUpgradePending.slot === q.num) return; // already captured
        let it = character.items[q.num];
        let p = it && it.name === "placeholder" ? it.p : null;
        telemetryUpgradePending = {
            slot: q.num,
            chance: p && typeof p.chance === "number" ? p.chance : null,
            item: p && typeof p.name === "string" ? p.name.slice(0, 24) : null,
            level: p && typeof p.level === "number" ? p.level : null,
            scroll: p && typeof p.scroll === "string" ? p.scroll : null,
            offering: p && typeof p.offering === "string" ? p.offering : null
        };
        telemetryUpgradeResolveAt = 0;
        return;
    }
    let pending = telemetryUpgradePending;
    if (!pending) return;
    if (!telemetryUpgradeResolveAt) {
        telemetryUpgradeResolveAt = Date.now() + TELEMETRY_UPGRADE_RESOLVE_GRACE_MS;
        return;
    }
    if (Date.now() < telemetryUpgradeResolveAt) return; // still within the grace period, check again next tick
    telemetryUpgradePending = null;
    telemetryUpgradeResolveAt = 0;
    let it = character.items[pending.slot];
    let success = !!(it && it.name === pending.item && (it.level || 0) === (pending.level || 0) + 1);
    telemetryLivePush({
        k: "upgrade",
        row: {
            t: Date.now(), slot: pending.slot, success: success,
            level: pending.level, item: pending.item, scroll: pending.scroll, offering: pending.offering,
            chance: pending.chance, roll: typeof pending.roll === "number" ? pending.roll : null
        }
    }, true);
}

// Same method the community "Lucky Slot Tracker" (by Crown, a game dev) uses: the server reveals an
// upgrade/compound roll one decimal digit at a time (as a "reels stopping" animation) over the raw
// q_data socket event, which isn't part of the documented character/game event API - CODE globals
// document parent.entities/chests/S/character as the sanctioned read-only surface, not parent.socket,
// so this taps one step further into internals than the rest of Telemetry. It's read-only (nothing is
// sent), so it carries no fair-play risk, but it could stop working if the client's internals change.
// A roll near 0.0000 confirms the slot's hidden bonus fired (see telemetryCheckUpgrade's comment); we
// fold the decoded value into the SAME per-attempt row above instead of a separate stream.
var telemetryQDataWarned = false;
function telemetryOnQData(event) {
    if (!event || !event.p || !Array.isArray(event.p.nums) || event.p.nums.length !== 4) return;
    if (!telemetryUpgradePending || telemetryUpgradePending.slot !== event.num) return; // not our tracked attempt
    if (typeof telemetryUpgradePending.roll === "number") return; // already decoded
    let n = event.p.nums;
    if (n.some(d => typeof d !== "number")) return;
    telemetryUpgradePending.roll = Math.round((n[3] * 1000 + n[2] * 100 + n[1] * 10 + n[0])) / 10000;
}
function telemetryHookQData() {
    if (typeof parent !== "undefined" && parent.socket && typeof parent.socket.on === "function") {
        parent.socket.on("q_data", telemetryOnQData);
    } else if (!telemetryQDataWarned) {
        telemetryQDataWarned = true;
        game_log("Telemetry: parent.socket is not available here, so decoded-roll tracking is off (win-rate tracking still works)");
    }
}

// --- event listeners ---
// Damage we take (or healing we receive): counted in total and by attacker monster type.
character.on("hit", function (d) {
    if (!d) return;
    // For a heal the game removes `damage` and reports the amount in `heal`.
    if (typeof d.heal === "number") {
        telemetryBump("hr", Math.abs(d.heal));
        telemetryScheduleFlush();
        return;
    }
    if (typeof d.damage !== "number") return;
    if (String(d.source || "").indexOf("heal") !== -1) {
        telemetryBump("hr", d.damage);
    } else {
        telemetryBump("tk", d.damage);
        let mt = telemetryMtype(d.actor);
        if (mt) {
            telemetryBumpMap("tkm", mt, d.damage);
            telemetryLastHit = { mt: mt, t: Date.now() };
        }
    }
    telemetryScheduleFlush();
});

// Damage we deal / heal we cast; killing blows counted by monster type.
character.on("target_hit", function (d) {
    if (!d) return;
    if (typeof d.heal === "number") {  // our own heal / partyheal landing on someone
        telemetryBump("heal", Math.abs(d.heal));
        telemetryScheduleFlush();
        return;
    }
    if (typeof d.damage !== "number") return;
    telemetryBump(String(d.source || "").indexOf("heal") !== -1 ? "heal" : "dmg", d.damage);
    if (d.kill) {
        telemetryBump("kb", 1);
        telemetryBumpMap("km", telemetryMtype(d.target), 1);
    }
    telemetryScheduleFlush();
});

character.on("death", function () {
    telemetryBump("deaths", 1);
    let recent = telemetryLastHit && Date.now() - telemetryLastHit.t < 8000 ? telemetryLastHit.mt : null;
    telemetryPushEvent({ e: "death", by: recent, m: character.map, x: Math.round(character.x), y: Math.round(character.y) });
});

character.on("level_up", function (d) {
    telemetryPushEvent({ e: "lvl", lv: d && d.level });
});

character.on("loot", function (d) {
    for (let it of (d && d.items) || []) {
        if (it && it.looter === character.name && typeof it.name === "string") telemetryBumpDrop(it.name, it.q || 1);
    }
    if (d && (d.gold > 0 || (d.items && d.items.length))) {
        telemetryPushEvent({
            e: "loot", id: String(d.id || ""), g: d.gold > 0 ? Math.round(d.gold) : 0,
            items: (d.items || []).map(it => String((it && it.name) || "?").slice(0, 30)).slice(0, 8)
        });
    }
});

// Gold moved between our own characters is not income or spending: track it so it can be excluded.
function telemetryOwnName(name) { return typeof name === "string" && name !== character.name && telemetryOwn.indexOf(name) !== -1; }
character.on("gold_sent", function (d) {
    if (!d || d.success === false) return;
    let gold = Number(d.gold != null ? d.gold : d.amount);
    if (telemetryOwnName(d.to || d.name) && gold > 0) {
        telemetryBump("gs", gold);
        telemetryScheduleFlush();
    }
});
character.on("gold_received", function (d) {
    if (!d) return;
    let gold = Number(d.gold != null ? d.gold : d.amount);
    if (telemetryOwnName(d.from || d.name) && gold > 0) {
        telemetryBump("gr", gold);
        telemetryScheduleFlush();
    }
});

// --- startup ---
if (telemetryIsMerchant) {
    game.on("sale", telemetryOnSale);
    setInterval(function () { telemetrySlotCache = telemetrySnapshotSlots(); }, 2000);
    setInterval(telemetryCheckUpgrade, 200); // property read only, no server-call cost
    telemetryHookQData();
}
// Watch our own server call cost so the dashboard can show the margin below the disconnect limit.
setInterval(function () {
    let cc = telemetryCc();
    if (cc === null) {
        if (++telemetryCcNulls === 120) game_log("Telemetry: character.cc is not available here, so call cost cannot be tracked");
    } else if (cc > telemetryCcMax) telemetryCcMax = cc;
}, 1000);
setInterval(telemetryHeartbeat, TELEMETRY_CONFIG.liveHeartbeatMs);
