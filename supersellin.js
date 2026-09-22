// --- MERCHANT SCRIPT (SuperSellin) ---
performance_trick();
use_hp_or_mp();
const CONFIG = {
    townSpot: { map: "main", x: -20, y: -70 },
    vendorTarget: "potions",
    tankName: "DerstnTanks",
    authorizedParty: ["Derstn", "DerstnTanks", "DerstnHeals", "DerstnMage"],
    patrolIntervalMs: 10 * 60 * 1000 // 6 minutes
};

const EX_CONFIG = {
    npcName: "Xyn",
    itemsToExchange: ["marketparcel", "anniversarygift", "gem0", "gem1", "armorbox", "weaponbox", "gift0"],
    minFreeSlots: 3,
    delayBetweenExchanges: 1200
};

// Expand junk to include common cave/desert drops
const JUNK_ITEMS = [
    "hpbelt", "hpamulet", "cshirt", "pants1",
    "stinger", "ringsj", "gloves", "helmet", "poker", "partyhat", "shoes", "confetti", "cake", "vitring", "wattire", "coat", "pants", "wbreeches", "wgloves", "wshoes"];

let deliveryQueue = [];
let isBusy = false;

// 1. Maintain MLuck & Auto-loot
setInterval(() => {
    loot();
    if (!character.s?.mluck && !is_on_cooldown("mluck")) {
        use_skill("mluck", character);
    }
}, 1000);

// Open merchant stand if not already open
function openStand() {
    if (!character.stand) {
        // In AL, opening a stand uses open_merchant() or open_stand()
        if (typeof open_stand === "function") {
            open_stand();
        } else if (parent && parent.open_merchant) {
            parent.open_merchant(0); // 0 corresponds to the standard stand appearance
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
        // Give the server 300ms to clear the stand state before pathfinding
        await new Promise(resolve => setTimeout(resolve, 300));
    }
}

// Helper: Count quantity of an item
function countItem(name) {
    let total = 0;
    for (let slot of character.items) {
        if (slot && slot.name === name) total += slot.q || 1;
    }
    return total;
}

// Helper: Count empty bag slots
function getFreeSlots() {
    return character.items.filter(slot => !slot).length;
}

// Helper: Find item slot for exchange
function findExchangeItemSlot() {
    return character.items.findIndex(item => 
        item && EX_CONFIG.itemsToExchange.includes(item.name)
    );
}

// Helper: Find NPC entity
function findNpc(id) {
    for (let entityId in parent.entities) {
        let entity = parent.entities[entityId];
        if (entity.npc_id === id || entity.id === id || entity.name === id) {
            return entity;
        }
    }
    return null;
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

// 3. Exchange Routine (Executed safely when in town)
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

// 4. Listen for CM Calls
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

// 5. 6-Minute Regular Patrol Sweep
setInterval(() => {
    if (!deliveryQueue.some(t => t.type === "patrol")) {
        deliveryQueue.push({ type: "patrol" });
    }
}, CONFIG.patrolIntervalMs);

// Primary Logistics Runner
async function processQueue() {
    if (isBusy || character.rip) return;

    const hasExchangeItems = findExchangeItemSlot() !== -1;
    if (deliveryQueue.length === 0 && !hasExchangeItems) {
        // If idle in town and not moving, keep the shop open
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
        // 1. Pack up the shop before departing
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
                if (buyHp > 0) buy("hpot1", buyHp);
                if (buyMp > 0) buy("mpot1", buyMp);
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

                for (let name of CONFIG.authorizedParty) {
                    let p = get_player(name);
                    if (p && !p.s?.mluck && !is_on_cooldown("mluck")) {
                        use_skill("mluck", p);
                        break;
                    }
                }

                set_message("Collecting Loot");
                loot();
                await new Promise(resolve => setTimeout(resolve, 8000));
            }
        }

        // 2. Return to town, vendor junk, and handle exchanges
        set_message("Returning Town");
        await smart_move(CONFIG.townSpot);
        sellJunk();

        if (findExchangeItemSlot() !== -1) {
            await executeExchangeRoutine();
            await smart_move(CONFIG.townSpot);
            sellJunk();
        }

        // 3. Reopen shop while parked at the town spot
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