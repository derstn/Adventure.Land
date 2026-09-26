// --- MERCHANT SCRIPT (SuperSellin) ---
performance_trick();

// Shared account CODE slots (see adventureland/codes/): party management and
// misc helpers are identical across characters. No CombatSupport here - the
// merchant is the recipient of the mule/potion-request calls, not a participant.
load_code("PartyManager");
load_code("Utils");

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
        "stramulet", "dexamulet", "intamulet",
    ],
    maxLevel: 3, // Compounding stops once +3 is achieved
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

const JUNK_ITEMS = [
    "hpbelt", "hpamulet", "cshirt", "pants1",
    "stinger", "ringsj", "gloves", "helmet", "poker", "partyhat", "shoes", "confetti", "cake", "vitring", "wattire", "coat", "pants", "wbreeches", "wgloves", "wshoes", "wcap", "cclaw", "coat1", "helmet1",
];

let deliveryQueue = [];
let isBusy = false;

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
    if (isBusy) return;
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
function findCompoundSet() {
    for (let itemName of COMPOUND_CONFIG.accessoryTypes) {
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
        await compound(set.slots[0], set.slots[1], set.slots[2], scrollSlot);
        await new Promise(r => setTimeout(r, COMPOUND_CONFIG.delayBetweenActions));

        set = findCompoundSet();
    }
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
                await smart_move({ x: task.x, y: task.y, map: task.map });
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
                await smart_move(targetLoc);

                // Top off MLuck on all party members with < 30 minutes left
                await refreshPartyMLuck();

                set_message("Collecting Loot");
                loot();
                await new Promise(resolve => setTimeout(resolve, 8000));
            }
        }

        // --- Town Sequence: Vendor -> Compound Accessories -> Exchanges ---
        set_message("Returning Town");
        await smart_move(CONFIG.townSpot);
        sellJunk();

        // 1. Process Accessories (+0 through +2)
        if (findCompoundSet()) {
            await executeCompoundingRoutine();
        }

        // 2. Process Parcel & Gift Exchanges
        if (findExchangeItemSlot() !== -1) {
            await executeExchangeRoutine();
            await smart_move(CONFIG.townSpot);
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
