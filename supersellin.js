// --- MERCHANT SCRIPT (SuperSellin) ---
performance_trick();

// Shared account CODE slots (see adventureland/codes/): party management and
// misc helpers are identical across characters. No CombatSupport here - the
// merchant is the recipient of the mule/potion-request calls, not a participant.
load_code("PartyManager");
load_code("Utils");
load_code("LiveConfig"); // optional private slot written by tools/telemetry_dashboard.py --serve; enables live push
load_code("Telemetry"); // farm metrics + sales log for the dashboard; starts timers, load once

setInterval(() => {
    if (character.rip) return;
    if (is_on_cooldown("use_hp")) return;

    // Prioritize emergency HP potion if below 70%
    if (character.hp < character.max_hp * 0.7) {
        use_skill("use_hp");
    } 
    // Restore MP if below 50% (important for casting MLuck on the party)
    else if (character.mp < character.max_mp * 0.5) {
        use_skill("use_mp");
    } 
    // Fallback to free regen if lightly damaged or missing small MP
    else if (character.hp < character.max_hp) {
        use_skill("regen_hp");
    } else if (character.mp < character.max_mp) {
        use_skill("regen_mp");
    }
}, 500);

const CONFIG = {
    // In range of "basics" (Gabriel, buy gear items) without moving - confirmed by the user manually.
    // "scrolls" (Lucas) is ~337px away from here (main map npc position [-464,-96]), well outside any
    // plausible buy() range, so a scroll purchase will likely still trigger a real smart_move trip;
    // upgrading itself never needed proximity to begin with (see GEARUP_CONFIG's upgrade-shrine note).
    townSpot: { map: "main", x: -135.9999999, y: -18.385177137868247 },
    vendorTarget: "potions",
    scrollTarget: "scrolls",
    tankName: "DerstnTanks",
    authorizedParty: ["Derstn", "DerstnTanks", "DerstnHeals", "DerstnMage"],
    patrolIntervalMs: 15 * 60 * 1000 // 15 minutes
};

const COMPOUND_CONFIG = {
    accessoryTypes: [
        "strbelt", "dexbelt", "intbelt"
    ],
    maxLevel: 3, // Items at this level are never compounded further
    // Stop compounding a type once the merchant holds this many finished (+maxLevel) items of it
    // (one per combat character). Goes back to compounding if you take them out of the merchant's bags.
    goalCount: { stramulet: 2, dexamulet: 2, intamulet: 2 },
    maxAttemptsPerHour: 60, // rolling cap on compound calls (one +3 needs 13+ successful calls from +0s); frees up as calls age past an hour
    scrollTiers: {
        0: "cscroll0", // +0 -> +1
        1: "cscroll0", // +1 -> +2
        2: "cscroll1"  // +2 -> +3 (Change to "cscroll0" if you want to use basic scrolls)
    },
    delayBetweenActions: 1000
};

const EX_CONFIG = {
    npcName: "Xyn",
    itemsToExchange: ["marketparcel", "anniversarygift", "gem0", "gem1", "armorbox", "weaponbox", "gift0", "candy0", "candy1"],
    minFreeSlots: 3,
    delayBetweenExchanges: 1200
};

// --- GEAR-UP: basic armor (coat/pants/gloves/shoes/helmet) to +9 for the ranger and warrior ---
// COST WARNING (verified against the game's real design/upgrades.js chance table, not a guess): a
// failed upgrade destroys the item outright, so going from +0 to +7 on the cheap Normal scroll alone
// costs roughly 280,000 gold in EXPECTATION per copy (accounting for every failure point, not just a
// naive single-run estimate) - and +7->+9 needs the 40,000g High Upgrade Scroll, where a single bad
// roll costs far more than the item itself. maxSpendPerHour is the only thing standing between this
// and draining the account; set it to something you can genuinely afford to lose indefinitely, not
// just your average income (a bad-variance stretch WILL burn the full cap with nothing to show).
const GEARUP_CONFIG = {
    enabled: false, // turned off by request - buying finished gear directly was faster/cheaper than grinding it out here

    itemOrder: ["coat", "pants", "gloves", "shoes", "helmet"], // fully finish one (both copies) before starting the next
    copiesPerItem: 2, // one for the ranger, one for the warrior - banked, not delivered, see bankPack below
    targetLevel: 9,
    // This character's confirmed lucky slot - the only slot in ~10.7k logged rolls with ANY 00.00
    // rolls (42 of them, vs. 0 across the other 41 slots combined over 6,797 rolls) and roughly half
    // the high-roll (>96.3%) rate of the rest, exactly matching the boosted-roll-pulldown mechanic
    // (see adventureland_project.md for the full analysis). Sampling is done - every upgrade attempt
    // runs from here now, no more rotation.
    luckySlot: 21,
    maxSpendPerHour: 150000, // GOLD CAP - a placeholder, not a recommendation; tune to what you can afford to lose, see comment above
    // No npc travel targets needed anymore: CONFIG.townSpot is in buy() range of every gear-up vendor
    // (basics, the scroll vendor) and upgrade()/compound() never needed proximity to begin with.
    // Finished +9 items are banked in "items1" (Gabriella - confirmed via game_data npcs, not sent to
    // the ranger/warrior directly), NOT sent to the ranger/warrior directly - their own CombatSupport
    // mule-offload code sends back anything not in its keepItems whitelist, which would just bounce
    // the finished item straight back to SuperSellin. "items0" (Gabrielle) is reserved for crafting
    // materials, kept separate.
    bankPack: "items1",
    delayBetweenActions: 800
};

// Persisted via get/set (browser localStorage - survives CODE restarts, per the game's own
// "Add Persistence!" pattern) since this can run for a very long time across many restarts.
let gearupSpendLog = get("gearupSpendLog") || [];  // [{t, amount}] - rolling-hour spend ledger
let gearupBanked = get("gearupBanked") || {};      // { itemName: count } already deposited in bankPack
// The exact cost of whatever gear-up couldn't afford last time (0 = not currently blocked). Cheap
// steps (buying the item, scroll0) rarely exhaust a realistic cap on their own - it's almost always
// the 40,000g scroll1 purchase that actually gets blocked while plenty of "any" headroom remains, so
// tracking just "is there any headroom" doesn't work: it would still call executeGearupRoutine every
// 3s only to immediately re-hit the exact same block. Remembering the specific blocked amount lets
// processQueue skip gear-up entirely until enough of the ledger ages out to cover THAT cost.
let gearupBlockedCost = get("gearupBlockedCost") || 0;
// Per-climb cost breakdown, for transparency - separate from gearupSpendLog (a flat rolling-hour cap
// ledger with no notion of "which item this gold was for"). gearupClimb accumulates every item and
// scroll purchase toward the CURRENT copy of the CURRENT item type, surviving across a failure+rebuy
// (still the same logical climb toward one +9) and across an interrupt/resume, but resets the moment
// a fresh climb genuinely starts (a new item type, or the previous copy just finished). The moment a
// copy reaches +9 and gets banked, the running total is finalized into gearupHistory and reset to null.
let gearupClimb = get("gearupClimb") || null; // { item, startedAt, gold, items, scrolls: {name: qty}, attempts }
let gearupHistory = get("gearupHistory") || []; // finished climbs, newest last, capped at 50 entries

function gearupSaveState() {
    set("gearupSpendLog", gearupSpendLog);
    set("gearupBanked", gearupBanked);
    set("gearupBlockedCost", gearupBlockedCost);
    set("gearupClimb", gearupClimb);
    set("gearupHistory", gearupHistory);
}

// Starts a fresh climb record if one isn't already running for this exact item type.
function gearupEnsureClimb(itemName) {
    if (gearupClimb && gearupClimb.item === itemName) return;
    gearupClimb = { item: itemName, startedAt: Date.now(), gold: 0, items: 0, scrolls: {}, attempts: 0 };
}

function gearupRecentSpend() {
    let cutoff = Date.now() - 60 * 60 * 1000;
    gearupSpendLog = gearupSpendLog.filter(e => e.t > cutoff);
    return gearupSpendLog.reduce((sum, e) => sum + e.amount, 0);
}

// Checked BEFORE every gold-spending action (buy or upgrade attempt). Returns false, and logs once,
// the moment the rolling hour would go over the cap - the caller must stop, not retry.
function gearupCanSpend(amount) {
    return gearupRecentSpend() + amount <= GEARUP_CONFIG.maxSpendPerHour;
}

// True unless gear-up is specifically blocked on the exact cost it couldn't afford last time. Used
// to decide whether gear-up counts as "work to do" for processQueue's idle check - without this, a
// capped gear-up still looked like pending work every 3s (gearupActiveItem() never returns null while
// an item type is unfinished, capped or not), so the merchant closed its stand, pathed back to town,
// and reopened it every single tick for nothing, re-hitting the identical block each time. Once
// truly blocked, gear-up isn't attempted again until enough of the ledger ages out to cover that
// specific cost, so the merchant just sits with its stand open like any other idle tick meanwhile.
function gearupCanProceed() {
    return gearupCanSpend(gearupBlockedCost);
}

function gearupLogSpend(amount) {
    gearupSpendLog.push({ t: Date.now(), amount });
    gearupBlockedCost = 0; // a spend just went through - clearly not blocked right now
    gearupSaveState();
}

function gearupScrollFor(item) {
    let grade = item_grade(item);
    return "scroll" + Math.max(0, grade);
}

// The item type currently being worked (first in itemOrder not yet delivered to every recipient).
function gearupActiveItem() {
    if (!GEARUP_CONFIG.enabled) return null; // fully off, not just skipped inside executeGearupRoutine -
    // this also clears hasGearupWork in processQueue, so a disabled gear-up causes zero extra activity
    // (no wasted close-stand/pathfind cycles the way a merely-capped run still would have, since there's
    // nothing pending to resume - it's off, not paused).
    for (let name of GEARUP_CONFIG.itemOrder) {
        if ((gearupBanked[name] || 0) < GEARUP_CONFIG.copiesPerItem) return name;
    }
    return null; // everything finished
}

// Casts the strongest available "mass X" speed buff immediately before a real upgrade/compound/
// exchange attempt, cutting THAT ONE roll/exchange's time by 50% (base) or 90% (++). The buff is a
// one-shot that expires in 10s if unused, so this must only ever be called right before the action
// it's meant to speed up, never cached/pre-cast ahead of time. Prefers ++ when unlocked/affordable/off
// cooldown, falls back to the base version, and is a safe no-op if neither is - never blocks or delays
// the real action waiting on it. Real costs verified via MCP game data (G.skills, not guessed):
// massproduction lvl 30/20mp, massproductionpp lvl 60/200mp (both cover upgrade OR compound);
// massexchange lvl 40/30mp, massexchangepp lvl 70/200mp - all four share a 50ms cooldown and a 10s
// buff expiry. can_use() only checks class eligibility + local cooldown (per its own doc, "does not
// replace the server's complete skill validation"), so level/mp are checked here explicitly too.
async function castSpeedBuff(baseSkill, ppSkill) {
    for (let name of [ppSkill, baseSkill]) {
        let def = G.skills[name];
        if (!def) continue;
        if (character.level < def.level) continue;
        if (character.mp < def.mp) continue;
        if (!can_use(name)) continue;
        await use_skill(name).catch(() => {});
        return;
    }
}

async function executeGearupRoutine() {
    if (!GEARUP_CONFIG.enabled) return;
    let itemName = gearupActiveItem();
    if (!itemName) return;

    set_message("Gearing Up");
    let itemDef = G.items[itemName];
    // Buying and upgrading both happen in place at CONFIG.townSpot now (no travel needed - see the
    // earlier comments on that), so there's no reason the stand needs to stay closed for the whole
    // session the way a normal travel-heavy town-sequence step does. Reopen here; the only step below
    // that actually needs to move (banking a finished item) closes it again just for that round trip.
    openStand();

    while (!character.rip) {
        // Yield to anything higher-priority (potion restock requests, urgent pickups, the 15-min
        // patrol) waiting in deliveryQueue - gear-up would otherwise hold isBusy through its entire
        // multi-attempt run (it can go for a long time on a real gold budget) and starve everything
        // else. Nothing is lost by stopping here: the item just sits at whatever level it's at, in
        // real inventory, and the next call to this routine picks it right back up where it left off.
        if (deliveryQueue.length > 0) {
            game_log("Gear-up: pausing for a higher-priority delivery/patrol task.");
            break;
        }

        itemName = gearupActiveItem();
        if (!itemName) break;
        itemDef = G.items[itemName];

        // A finished +9: bank it in Gabriella (items1) instead of sending it to the ranger/warrior -
        // their own mule-offload code (CombatSupport.js) would just send anything not in its
        // keepItems whitelist straight back to SuperSellin, bouncing the finished item pointlessly.
        let doneSlot = character.items.findIndex(it => it && it.name === itemName && (it.level || 0) >= GEARUP_CONFIG.targetLevel);
        if (doneSlot !== -1) {
            set_message(`Banking ${itemName}`);
            await closeStand(); // must be closed to move at all
            await smart_move("bank");
            if (typeof telemetrySnapshotBank === "function") telemetrySnapshotBank(); // dashboard "Bank" panel - piggybacks on this trip, no extra travel
            doneSlot = character.items.findIndex(it => it && it.name === itemName && (it.level || 0) >= GEARUP_CONFIG.targetLevel);
            let stored = doneSlot !== -1
                ? await bank_store(doneSlot, GEARUP_CONFIG.bankPack).catch(err => { game_log(`Gear-up bank deposit failed: ${(err && err.reason) || err}`); return null; })
                : null;
            // Back to the work position either way - without this, every buy() after the first bank
            // trip would start failing (wrong map / out of vendor range) since nothing else repositions.
            await safeMove(CONFIG.townSpot);
            openStand();
            if (!stored) break; // don't loop forever on a persistent bank failure (e.g. pack full)
            gearupBanked[itemName] = (gearupBanked[itemName] || 0) + 1;
            // Finalize this copy's cost breakdown (transparency: how many items/scrolls/gold it
            // actually took, including any failed-and-rebought attempts along the way) into history.
            if (gearupClimb && gearupClimb.item === itemName) {
                gearupHistory.push({ item: itemName, gold: gearupClimb.gold, items: gearupClimb.items,
                    scrolls: gearupClimb.scrolls, attempts: gearupClimb.attempts,
                    startedAt: gearupClimb.startedAt, finishedAt: Date.now() });
                if (gearupHistory.length > 50) gearupHistory.shift();
                game_log(`+9 ${itemName} cost breakdown: ${gearupClimb.items} item(s), ` +
                    `${Object.entries(gearupClimb.scrolls).map(([n, q]) => q + "x " + n).join(", ") || "0 scrolls"}, ` +
                    `${gearupClimb.attempts} real attempts, ${gearupClimb.gold}g total.`);
                gearupClimb = null;
            }
            gearupSaveState();
            game_log(`Banked +${GEARUP_CONFIG.targetLevel} ${itemName} in Gabriella (${gearupBanked[itemName]}/${GEARUP_CONFIG.copiesPerItem}).`);
            continue;
        }

        // No finished copy and no partial copy in progress: buy a fresh +0 to start (or resume) the climb.
        let workingSlot = character.items.findIndex(it => it && it.name === itemName && (it.level || 0) < GEARUP_CONFIG.targetLevel);
        if (workingSlot === -1) {
            if (!gearupCanSpend(itemDef.g)) {
                gearupBlockedCost = itemDef.g;
                gearupSaveState();
                game_log(`Gear-up: hourly cap reached, pausing before buying another ${itemName}.`);
                break;
            }
            set_message(`Buying ${itemName}`);
            // No travel needed: CONFIG.townSpot is confirmed in buy() range of every gear-up vendor
            // (user-verified manually), and the town sequence already safeMove()s here before gear-up
            // ever runs - a smart_move here was pure dead time on every single upgrade attempt.
            let bought = await upgrade_buy_item(itemName).catch(err => { game_log(`Gear-up buy failed: ${(err && err.reason) || err}`); return null; });
            if (!bought) break;
            gearupLogSpend(bought.cost || itemDef.g);
            gearupEnsureClimb(itemName);
            gearupClimb.gold += bought.cost || itemDef.g;
            gearupClimb.items += 1;
            // Move it into the lucky slot HERE, ONCE per fresh item (not once per attempt) so the item
            // sits still for its entire climb - see the big comment further down for why moving it
            // mid-climb was a real bug when this used to rotate freely.
            if (typeof bought.num === "number" && bought.num !== GEARUP_CONFIG.luckySlot) {
                await swap(bought.num, GEARUP_CONFIG.luckySlot).catch(() => {});
            }
            gearupSaveState();
            await new Promise(r => setTimeout(r, GEARUP_CONFIG.delayBetweenActions));
            continue;
        }

        let item = character.items[workingSlot];
        let scrollNeeded = gearupScrollFor(item);
        let scrollDef = G.items[scrollNeeded];
        let scrollSlot = character.items.findIndex(it => it && it.name === scrollNeeded);

        if (scrollSlot === -1) {
            if (!gearupCanSpend(scrollDef.g)) {
                gearupBlockedCost = scrollDef.g;
                gearupSaveState();
                game_log(`Gear-up: hourly cap reached, pausing before buying ${scrollNeeded}.`);
                break;
            }
            set_message(`Buying ${scrollNeeded}`);
            // Same as above - townSpot is in range of the scroll vendor too, no travel needed.
            let bought = await buy(scrollNeeded, 1).catch(err => { game_log(`Gear-up scroll buy failed: ${(err && err.reason) || err}`); return null; });
            if (!bought) break;
            gearupLogSpend(bought.cost || scrollDef.g);
            gearupEnsureClimb(itemName);
            gearupClimb.gold += bought.cost || scrollDef.g;
            gearupClimb.scrolls[scrollNeeded] = (gearupClimb.scrolls[scrollNeeded] || 0) + 1;
            gearupSaveState();
            await new Promise(r => setTimeout(r, GEARUP_CONFIG.delayBetweenActions));
            continue;
        }

        if (!gearupCanSpend(scrollDef.g)) {
            gearupBlockedCost = scrollDef.g;
            gearupSaveState();
            game_log(`Gear-up: hourly cap reached, pausing before the next ${itemName} upgrade attempt.`);
            break;
        }
        gearupBlockedCost = 0; // about to actually spend/act - not blocked

        set_message(`Upgrading ${itemName}`);
        // No travel to the upgrade shrine needed at all: upgrade()'s documented rejection reasons
        // never include "distance" (unlike buy()'s), confirming it works from anywhere - parking at
        // the gear vendor (or anywhere else) and never walking to Cue is correct, not a shortcut.

        // NOTE: this used to rotate the item to a new inventory slot right here, before every single
        // attempt (to sample all 42 slots for the lucky-slot tracker). That was a real bug, not just
        // noise: Telemetry's lucky-slot tracker (Telemetry.js, telemetryCheckUpgrade) is a SEPARATE,
        // independent 200ms poller that infers success/fail by remembering which slot an attempt
        // started in and checking what's sitting there once the attempt ends - it only works if
        // nothing else moves the item out of that slot in the meantime. Rotating mid-climb raced
        // against that poll under real network jitter, misreporting real successes as "fail" in the
        // win-rate stats (gear-up's own spending/leveling logic was never affected - it always used
        // the real upgrade() result, never this heuristic). Sampling is done now: slot 21 is confirmed
        // as this account's lucky slot (see GEARUP_CONFIG.luckySlot's comment), so every fresh item
        // purchase is moved there once (see the buy branch above) and stays for its whole climb - no
        // more rotation, and both the race above and the "sample every slot" reason for moving
        // mid-climb are gone.

        while (character.q && character.q.upgrade) {
            await new Promise(r => setTimeout(r, 250));
        }

        let preview = await upgrade(workingSlot, scrollSlot, null, true).catch(() => null);
        if (preview) game_log(`${itemName} +${item.level || 0} -> +${(item.level || 0) + 1}: ${(preview.chance * 100).toFixed(2)}% chance (${scrollNeeded})`);

        // No new gearupLogSpend() here - the scroll's cost was already logged when it was BOUGHT
        // (above); this attempt just consumes an already-paid-for scroll, not new gold.
        await castSpeedBuff("massproduction", "massproductionpp");
        let result = await upgrade(workingSlot, scrollSlot).catch(err => ({ success: false, rejected: true, reason: err && err.reason }));
        if (result.rejected) {
            game_log(`Gear-up upgrade call rejected: ${result.reason}`);
        } else {
            // A real attempt happened (as opposed to a rejected call, which never reached the server) -
            // count it toward this climb's breakdown regardless of outcome.
            gearupEnsureClimb(itemName);
            gearupClimb.attempts += 1;
            gearupSaveState();
            if (result.success) {
                game_log(`${itemName} is now +${result.level}!`);
            } else {
                game_log(`${itemName} upgrade failed at +${item.level || 0} - item lost.`);
            }
        }

        await new Promise(r => setTimeout(r, GEARUP_CONFIG.delayBetweenActions));
    }
}

// buy() only returns {name, num, q, cost} on success - wrap so a rejected buy() and a truthy return
// are both easy to branch on above without duplicating the .catch() shape.
async function upgrade_buy_item(name) {
    return await buy(name);
}

// Deadlock breaker: exchange() needs free bag space just to start, but sellJunk/compounding can't
// touch gifts/parcels/gems/boxes (they aren't junk or accessories) - if the bag fills entirely with
// exchange-bound items there is nothing else that can ever free a slot, so it retries forever. When
// that happens, bank some overflow to guarantee room instead of getting stuck.
// Dashboard "Bank" panel freshness: the piggybacked snapshot calls (gear-up deposits, exchange
// overflow trips) only fire when there's some OTHER reason to visit the bank, which can leave the
// panel stale for a long time if gear-up is capped/disabled and nothing needs exchanging. This is a
// lowest-priority fallback, checked only when processQueue finds genuinely nothing else to do (no
// deliveries, no exchange, no compound, no gear-up) - it never competes with or delays real work.
const BANK_SNAPSHOT_CONFIG = { intervalMs: 30 * 60 * 1000 }; // how stale the Bank panel may get before an idle-time trip refreshes it
let lastBankSnapshotAt = 0;
async function snapshotBankPeriodically() {
    lastBankSnapshotAt = Date.now(); // set before the trip, not after - a failed/interrupted trip shouldn't retry every 3s
    set_message("Bank Snapshot");
    await smart_move("bank");
    if (typeof telemetrySnapshotBank === "function") telemetrySnapshotBank();
    await safeMove(CONFIG.townSpot);
    openStand();
}

const BANK_CONFIG = {
    potionReserve: 20,      // keep at least this many hpot1/mpot1 on hand for deliveries; bank any extra
    maxItemsToBank: 3,      // cap per bank trip so it can't run long
    cooldownMs: 5 * 60 * 1000
};

// coat/pants/gloves/shoes/helmet deliberately NOT listed here (even at +0) - GEARUP_CONFIG buys and
// upgrades exactly these from +0, and sellJunk() only skips items with level > 0, so leaving them in
// this list would auto-sell every freshly-bought gear-up item before it could ever be upgraded.
const JUNK_ITEMS = [
    "hpbelt", "hpamulet", "cshirt", "pants1",
    "stinger", "ringsj", "poker", "partyhat", "confetti", "cake", "vitring", "wattire", "wbreeches", "wgloves", "wshoes", "wcap", "cclaw", "coat1", "helmet1", "stramulet", "intamulet", "dexamulet", "swifty",
	"dexring", "intring", "strring",
];

let deliveryQueue = [];
let isBusy = false;

// Preferred routes. smart_move always takes the SHORTEST path, and between Mainland and Spooky Town that is
// through Underground [Entrance] (level1), where Vampire Rats stand beside both exits. Each entry forces a chain
// of waypoints (a map's own spawn points, i.e. safe arrival spots) so that every leg's shortest path is the
// safe one: Mainland -> Spooky Forest -> Spooky Town and back. Key = "current map>destination map".
const ROUTE_CONFIG = {
    "main>spookytown": [
        { map: "halloween", x: 1212, y: 101 },   // arrival from Mainland's east door
        { map: "halloween", x: 784, y: -1060 }   // just below the door into Spooky Town
    ],
    "spookytown>main": [
        { map: "spookytown", x: 32, y: 1404 },   // arrival point at the door back to Spooky Forest
        { map: "halloween", x: 784, y: -1060 },
        { map: "halloween", x: 1212, y: 101 }    // beside the door to Mainland
    ]
};

async function safeMove(dest) {
    const to = (dest && dest.map) || character.map;
    const chain = ROUTE_CONFIG[character.map + ">" + to] || [];
    for (const waypoint of chain) {
        await smart_move(waypoint);
    }
    return await smart_move(dest);
}

// If a trip is interrupted the merchant can end up away from town with nothing queued; bring him home.
let lastRecoverAt = 0;
async function recoverToTown() {
    if (isBusy || Date.now() - lastRecoverAt < 30000) return;
    lastRecoverAt = Date.now();
    isBusy = true;
    try {
        set_message("Returning Town");
        await closeStand();
        await safeMove(CONFIG.townSpot);
    } catch (err) {
        game_log("Recover to town failed: " + ((err && (err.reason || err.message)) || JSON.stringify(err)));
    } finally {
        isBusy = false;
    }
}


// 1. Maintain Self MLuck & Auto-loot
setInterval(() => {
    loot();
    if (!character.s?.mluck && !is_on_cooldown("mluck")) {
        use_skill("mluck", character);
    }
}, 1000);

// Open merchant stand if not already open
function openStand() {
    if (!character.stand) {
        if (typeof open_stand === "function") {
            open_stand();
        } else if (parent && parent.open_merchant) {
            parent.open_merchant(0);
        }
        set_message("Shop Open");
    }
}

// Close merchant stand before moving
async function closeStand() {
    if (character.stand) {
        if (typeof close_stand === "function") {
            close_stand();
        } else if (parent && parent.close_merchant) {
            parent.close_merchant();
        }
        set_message("Packing Shop");
        await new Promise(resolve => setTimeout(resolve, 300));
    }
}

// Helpers
function getFreeSlots() {
    return character.items.filter(slot => !slot).length;
}

function findExchangeItemSlot() {
    return character.items.findIndex(item => 
        item && EX_CONFIG.itemsToExchange.includes(item.name)
    );
}

function findNpc(id) {
    for (let entityId in parent.entities) {
        let entity = parent.entities[entityId];
        if (entity.npc_id === id || entity.id === id || entity.name === id) {
            return entity;
        }
    }
    return null;
}

// Helper: Refresh MLuck on any party member missing it or with < 30 minutes remaining
async function refreshPartyMLuck() {
    const THIRTY_MINUTES_MS = 30 * 60 * 1000;

    for (let name of CONFIG.authorizedParty) {
        let p = get_player(name);
        if (!p || character.rip) continue;

        let mluckRemaining = p.s?.mluck ? (p.s.mluck.ms || 0) : 0;

        if (mluckRemaining < THIRTY_MINUTES_MS) {
            while (is_on_cooldown("mluck")) {
                await new Promise(r => setTimeout(r, 100));
            }

            if (character.mp >= 10 && distance(character, p) <= 320) {
                set_message(`MLuck -> ${name}`);
                use_skill("mluck", p);
                game_log(`Refreshed MLuck on ${name} (${Math.round(mluckRemaining / 60000)}m left)`);
                await new Promise(r => setTimeout(r, 400));
            }
        }
    }
}

// 2. Auto-sell Junk Drops
function sellJunk() {
    let soldCount = 0;
    for (let i = 0; i < character.items.length; i++) {
        let item = character.items[i];
        if (!item || (item.level && item.level > 0)) continue;
        if (JUNK_ITEMS.includes(item.name)) {
            sell(i, item.q || 1);
            soldCount++;
        }
    }
    if (soldCount > 0) game_log(`Sold ${soldCount} junk items.`);
}
setInterval(sellJunk, 5000);

// --- AUTO-COMPOUNDING ACCESSORIES (+0 -> +3) ---
let compoundTimes = []; // timestamps of recent compound calls (in memory, cleared on CODE restart)

function recentCompoundAttempts() {
    let cutoff = Date.now() - 60 * 60 * 1000;
    compoundTimes = compoundTimes.filter(t => t > cutoff);
    return compoundTimes.length;
}

function countAtLevel(name, level) {
    return character.items.filter(it => it && it.name === name && (it.level || 0) === level).length;
}

function goalReached(name) {
    let goal = COMPOUND_CONFIG.goalCount[name] || 1;
    return countAtLevel(name, COMPOUND_CONFIG.maxLevel) >= goal;
}

function findCompoundSet() {
    if (recentCompoundAttempts() >= COMPOUND_CONFIG.maxAttemptsPerHour) return null;
    for (let itemName of COMPOUND_CONFIG.accessoryTypes) {
        if (goalReached(itemName)) continue;
        for (let lvl = 0; lvl < COMPOUND_CONFIG.maxLevel; lvl++) {
            let matches = [];
            for (let i = 0; i < character.items.length; i++) {
                let it = character.items[i];
                if (it && it.name === itemName && (it.level || 0) === lvl) {
                    matches.push(i);
                    if (matches.length === 3) {
                        return { name: itemName, level: lvl, slots: matches };
                    }
                }
            }
        }
    }
    return null;
}

async function executeCompoundingRoutine() {
    let set = findCompoundSet();
    if (!set) return;

    set_message("Compounding Gear");
    game_log(`Beginning accessory compounding run...`);

    while (set && !character.rip) {
        let scrollNeeded = COMPOUND_CONFIG.scrollTiers[set.level] || "cscroll0";
        let scrollSlot = character.items.findIndex(it => it && it.name === scrollNeeded);

        if (scrollSlot === -1) {
            set_message(`Buying ${scrollNeeded}`);
            await smart_move({ to: CONFIG.scrollTarget });
            await buy(scrollNeeded, 5);
            await new Promise(r => setTimeout(r, 600));
            scrollSlot = character.items.findIndex(it => it && it.name === scrollNeeded);
            if (scrollSlot === -1) {
                game_log(`Failed to acquire ${scrollNeeded}. Halting compounding.`);
                break;
            }
        }

        while (character.q && character.q.compound) {
            await new Promise(r => setTimeout(r, 250));
        }

        game_log(`Compounding ${set.name} to +${set.level + 1}...`);
        compoundTimes.push(Date.now());
        await castSpeedBuff("massproduction", "massproductionpp");
        await compound(set.slots[0], set.slots[1], set.slots[2], scrollSlot);
        await new Promise(r => setTimeout(r, COMPOUND_CONFIG.delayBetweenActions));

        set = findCompoundSet();
    }
    if (recentCompoundAttempts() >= COMPOUND_CONFIG.maxAttemptsPerHour) {
        game_log(`Compound cap (${COMPOUND_CONFIG.maxAttemptsPerHour}/hour) reached; resumes as attempts age out.`);
    }
}

// Bank overflow to guarantee exchange has room, when selling junk and compounding couldn't free any.
let lastBankTripAt = 0;
async function makeRoomForExchange() {
    if (getFreeSlots() >= EX_CONFIG.minFreeSlots) return;
    if (Date.now() - lastBankTripAt < BANK_CONFIG.cooldownMs) return;
    lastBankTripAt = Date.now();

    set_message("Banking Overflow");
    game_log("Bags too full to exchange; banking overflow to make room...");
    await smart_move("bank");
    if (typeof telemetrySnapshotBank === "function") telemetrySnapshotBank(); // dashboard "Bank" panel - piggybacks on this trip, no extra travel

    let banked = 0;

    // 1. Excess potions beyond the delivery reserve
    for (let name of ["hpot1", "mpot1"]) {
        while (banked < BANK_CONFIG.maxItemsToBank && getFreeSlots() < EX_CONFIG.minFreeSlots
               && countItem(name) > BANK_CONFIG.potionReserve) {
            let slot = character.items.findIndex(it => it && it.name === name);
            if (slot === -1) break;
            await bank_store(slot);
            banked++;
            await new Promise(r => setTimeout(r, 300));
        }
    }

    // 2. Fallback: bank one exchange-item stack itself so at least the rest can go through
    while (banked < BANK_CONFIG.maxItemsToBank && getFreeSlots() < EX_CONFIG.minFreeSlots) {
        let slot = findExchangeItemSlot();
        if (slot === -1) break;
        await bank_store(slot);
        banked++;
        await new Promise(r => setTimeout(r, 300));
    }

    if (banked > 0) game_log(`Banked ${banked} stack(s) to free bag space.`);
    else game_log("Bank trip found nothing safe to bank (still stuck; will retry after cooldown).");
    await safeMove(CONFIG.townSpot);
}

// 4. Exchange Routine (Executed safely in town)
async function executeExchangeRoutine() {
    if (findExchangeItemSlot() === -1) return;

    if (getFreeSlots() < EX_CONFIG.minFreeSlots) {
        game_log("Exchanges skipped: Not enough free bag space.");
        return;
    }

    set_message("Moving to Xyn");
    let npc = findNpc(EX_CONFIG.npcName);
    if (!npc || distance(character, npc) > 250) {
        await smart_move({ to: "exchange" });
    }

    while (!character.rip) {
        if (getFreeSlots() < EX_CONFIG.minFreeSlots) {
            game_log("Exchanges paused: Bags nearly full.");
            break;
        }

        if (character.q && character.q.exchange) {
            await new Promise(r => setTimeout(r, 250));
            continue;
        }

        let slot = findExchangeItemSlot();
        if (slot === -1) {
            game_log("All gifts and parcels exchanged!");
            break;
        }

        let itemName = character.items[slot].name;
        set_message(`Exchanging ${itemName}`);
        await castSpeedBuff("massexchange", "massexchangepp");
        exchange(slot);

        await new Promise(r => setTimeout(r, EX_CONFIG.delayBetweenExchanges));
    }
}

// 5. Listen for CM Calls
function on_cm(name, data) {
    if (!CONFIG.authorizedParty.includes(name)) return;

    let payload = data;
    if (typeof data === "string") {
        try { payload = JSON.parse(data); } catch (e) { return; }
    }

    if (!payload) return;

    if (payload.action === "request_potions") {
        if (!deliveryQueue.some(t => t.recipient === name && t.type === "delivery")) {
            deliveryQueue.push({
                type: "delivery",
                recipient: name,
                hpNeeded: Number(payload.hpNeeded) || 0,
                mpNeeded: Number(payload.mpNeeded) || 0,
                x: payload.x,
                y: payload.y,
                map: payload.map || "main"
            });
            game_log(`Queued potion order for ${name}`);
        }
    } else if (payload.action === "request_pickup") {
        if (!deliveryQueue.some(t => t.type === "patrol")) {
            deliveryQueue.push({
                type: "patrol",
                x: payload.x,
                y: payload.y,
                map: payload.map || "main"
            });
            game_log(`Urgent pickup requested by ${name}!`);
        }
    }
}

// 6. Patrol Timer Sweep
setInterval(() => {
    if (!deliveryQueue.some(t => t.type === "patrol")) {
        deliveryQueue.push({ type: "patrol" });
    }
}, CONFIG.patrolIntervalMs);

// Primary Logistics Runner
async function processQueue() {
    if (isBusy || character.rip) return;

    const hasExchangeItems = findExchangeItemSlot() !== -1;
    const hasCompounds = findCompoundSet() !== null;
    const hasGearupWork = gearupActiveItem() !== null && gearupCanProceed();

    if (deliveryQueue.length === 0 && !hasExchangeItems && !hasCompounds && !hasGearupWork) {
        // Lowest priority: only considered once every other kind of work has already been ruled out
        // above, so a periodic Bank-panel refresh never delays a delivery, exchange, compounding, or
        // gear-up that becomes available a moment later.
        if (Date.now() - lastBankSnapshotAt >= BANK_SNAPSHOT_CONFIG.intervalMs) {
            isBusy = true;
            try {
                await closeStand();
                await snapshotBankPeriodically();
            } catch (err) {
                game_log(`Bank snapshot trip error: ${(err && err.message) || err}`);
            } finally {
                isBusy = false;
            }
            return;
        }
        if (character.map === CONFIG.townSpot.map &&
            distance(character, CONFIG.townSpot) < 50 &&
            !character.moving) {
            openStand();
        } else if (!character.moving) {
            recoverToTown();
        }
        return;
    }

    isBusy = true;
    const task = deliveryQueue.shift();

    try {
        await closeStand();

        if (task && task.type === "delivery") {
            set_message(`Restocking ${task.recipient}`);

            const currentHp = countItem("hpot1");
            const currentMp = countItem("mpot1");
            const buyHp = Math.max(0, task.hpNeeded - currentHp);
            const buyMp = Math.max(0, task.mpNeeded - currentMp);

            if (buyHp > 0 || buyMp > 0) {
                set_message("Buying Pots");
                await smart_move({ to: CONFIG.vendorTarget });
                if (buyHp > 0) await buy("hpot1", buyHp);
                if (buyMp > 0) await buy("mpot1", buyMp);
            }

            set_message(`To ${task.recipient}`);
            if (task.x !== undefined && task.y !== undefined) {
                await safeMove({ x: task.x, y: task.y, map: task.map });
            } else {
                await smart_move({ to: task.recipient });
            }

            await new Promise(resolve => setTimeout(resolve, 500));

            let hpSent = 0;
            let mpSent = 0;
            for (let i = 0; i < character.items.length; i++) {
                let item = character.items[i];
                if (!item) continue;
                if (item.name === "hpot1" && hpSent < task.hpNeeded) {
                    let toSend = Math.min(item.q || 1, task.hpNeeded - hpSent);
                    send_item(task.recipient, i, toSend);
                    hpSent += toSend;
                } else if (item.name === "mpot1" && mpSent < task.mpNeeded) {
                    let toSend = Math.min(item.q || 1, task.mpNeeded - mpSent);
                    send_item(task.recipient, i, toSend);
                    mpSent += toSend;
                }
            }

            // Also top off MLuck during potion deliveries
            await refreshPartyMLuck();

            set_message("Collecting Loot");
            loot();
            await new Promise(resolve => setTimeout(resolve, 7000));

        } else if (task && task.type === "patrol") {
            set_message("Patrol to Party");

            let targetLoc = null;
            if (task.x !== undefined && task.y !== undefined) {
                targetLoc = { x: task.x, y: task.y, map: task.map || "main" };
            } else if (parent.party && parent.party[CONFIG.tankName]) {
                let member = parent.party[CONFIG.tankName];
                if (member.x !== undefined && member.y !== undefined) {
                    targetLoc = { x: member.x, y: member.y, map: member.map || "main" };
                }
            } else {
                let p = get_player(CONFIG.tankName);
                if (p) targetLoc = { x: p.x, y: p.y, map: p.map || character.map };
            }

            if (targetLoc) {
                await safeMove(targetLoc);

                // Top off MLuck on all party members with < 30 minutes left
                await refreshPartyMLuck();

                set_message("Collecting Loot");
                loot();
                await new Promise(resolve => setTimeout(resolve, 8000));
            }
        }

        // --- Town Sequence: Vendor -> Compound Accessories -> Exchanges -> Gear-up ---
        set_message("Returning Town");
        await safeMove(CONFIG.townSpot);
        sellJunk();

        // 1. Process Accessories (+0 through +2)
        if (findCompoundSet()) {
            await executeCompoundingRoutine();
        }

        // 2. Process Parcel & Gift Exchanges
        if (findExchangeItemSlot() !== -1) {
            if (getFreeSlots() < EX_CONFIG.minFreeSlots) {
                await makeRoomForExchange();
            }
            await executeExchangeRoutine();
            await safeMove(CONFIG.townSpot);
            sellJunk();
        }

        // 3. Gear-up: buy/upgrade basics toward +9 (see GEARUP_CONFIG's cost warning)
        if (gearupActiveItem() && gearupCanProceed()) {
            // Guaranteed junk pass right before the long-running gear-up loop starts - the sellJunk()
            // a few lines up only reruns if exchanges actually happened, so a cycle with nothing to
            // exchange could otherwise go straight from arriving in town into gear-up (which can run
            // for a very long time before yielding back here) with only the very first pass behind it.
            sellJunk();
            await executeGearupRoutine();
        }

        // Reopen merchant stand
        openStand();

    } catch (err) {
        let msg = (err && err.message) ? err.message : (typeof err === "object" ? JSON.stringify(err) : String(err));
        game_log(`Runner error: ${msg}`);
    } finally {
        isBusy = false;
        set_message("Idle");
    }
}

setInterval(processQueue, 3000);
