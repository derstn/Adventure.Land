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
    townSpot: { map: "main", x: -20, y: -70 },
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

// Deadlock breaker: exchange() needs free bag space just to start, but sellJunk/compounding can't
// touch gifts/parcels/gems/boxes (they aren't junk or accessories) - if the bag fills entirely with
// exchange-bound items there is nothing else that can ever free a slot, so it retries forever. When
// that happens, bank some overflow to guarantee room instead of getting stuck.
const BANK_CONFIG = {
    potionReserve: 20,      // keep at least this many hpot1/mpot1 on hand for deliveries; bank any extra
    maxItemsToBank: 3,      // cap per bank trip so it can't run long
    cooldownMs: 5 * 60 * 1000
};

const JUNK_ITEMS = [
    "hpbelt", "hpamulet", "cshirt", "pants1",
    "stinger", "ringsj", "gloves", "poker", "partyhat", "shoes", "confetti", "cake", "vitring", "wattire", "coat", "pants", "wbreeches", "wgloves", "wshoes", "wcap", "cclaw", "coat1", "helmet1", "stramulet", "intamulet", "dexamulet", "swifty",
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

    if (deliveryQueue.length === 0 && !hasExchangeItems && !hasCompounds) {
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

        // --- Town Sequence: Vendor -> Compound Accessories -> Exchanges ---
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
