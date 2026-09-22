// --- WARRIOR SCRIPT (DerstnTanks) ---
performance_trick();

const CONFIG = {
    loopInterval: 250,
    lootInterval: 500,
    merchantName: "SuperSellin",
    targetTypes: ["scorpion"], // Update to your active mob
    partyMembers: ["Derstn", "DerstnHeals", "DerstnMage", "SuperSellin"]
};

setInterval(() => { loot(); }, CONFIG.lootInterval);

// --- UPDATED PROXIMITY MULE & CAPACITY ALERT ---
const MULE_CONFIG = {
    merchantName: "SuperSellin",
    goldReserve: 50000,
    transferDistance: 250,
    keepItems: ["tracker", "hpot1", "mpot1"]
};

let lastFullBagAlert = 0;

function offloadToMerchant() {
    if (character.rip) return;

    let merchant = get_player(MULE_CONFIG.merchantName);
    
    // If merchant is nearby, dump up to 6 items per second instead of just 1
    if (merchant && distance(character, merchant) <= MULE_CONFIG.transferDistance) {
        // Offload gold
        if (character.gold > MULE_CONFIG.goldReserve + 20000) {
            send_gold(MULE_CONFIG.merchantName, character.gold - MULE_CONFIG.goldReserve);
        }

        let sent = 0;
        for (let i = 0; i < character.items.length; i++) {
            let item = character.items[i];
            if (!item || MULE_CONFIG.keepItems.includes(item.name)) continue;

            send_item(MULE_CONFIG.merchantName, i, item.q || 1);
            sent++;
            if (sent >= 6) break; // Burst send to clear bags during the merchant's visit
        }
    }

    // Call for pickup on-demand if bags have 6 or fewer empty slots left
    let emptySlots = character.items.filter(i => !i).length;
    if (emptySlots <= 6 && Date.now() - lastFullBagAlert > 60000) {
        send_cm(MULE_CONFIG.merchantName, {
            action: "request_pickup",
            x: character.x,
            y: character.y,
            map: character.map
        });
        lastFullBagAlert = Date.now();
        set_message("Bag Full! Called Mule");
    }
}

setInterval(offloadToMerchant, 500);

// Survival Potions
function managePotions() {
    if (is_on_cooldown("use_hp")) return;
    if (character.hp < character.max_hp * 0.7) use_skill("use_hp");
    else if (character.mp < character.max_mp * 0.3) use_skill("use_mp");
    else if (character.hp < character.max_hp) use_skill("regen_hp");
}

// Aggro Control: Taunt any mob attacking squishy party members
function checkAggro() {
    if (is_on_cooldown("taunt") || character.mp < 40) return;

    for (let id in parent.entities) {
        let entity = parent.entities[id];
        if (entity.type !== "monster" || entity.dead) continue;

        if (CONFIG.partyMembers.includes(entity.target)) {
            if (distance(character, entity) <= 200) {
                use_skill("taunt", entity);
                change_target(entity);
                return;
            }
        }
    }
}

// Target Selection (Ignores outside tags)
function getValidTankTarget() {
    let current = get_targeted_monster();

    // Verify current target is still valid, alive, and not tagged by an outsider
    if (current && !current.dead && CONFIG.targetTypes.includes(current.mtype)) {
        if (!current.target || current.target === character.name || parent.party_list.includes(current.target)) {
            return current;
        }
    }

    let bestTarget = null;
    let minDistance = Infinity;

    for (let id in parent.entities) {
        let entity = parent.entities[id];
        if (entity.type !== "monster" || entity.dead) continue;
        if (!CONFIG.targetTypes.includes(entity.mtype)) continue;

        // Skip mobs that are locked onto a player NOT in our party
        if (entity.target && entity.target !== character.name && !parent.party_list.includes(entity.target)) {
            continue;
        }

        let dist = distance(character, entity);
        if (dist < minDistance) {
            minDistance = dist;
            bestTarget = entity;
        }
    }

    return bestTarget;
}

// Main Combat Loop
setInterval(() => {
    managePotions();
    if (character.rip) return;

    checkAggro();

    let target = getValidTankTarget();
    if (!target) return;

    if (get_targeted_monster() !== target) {
        change_target(target);
    }

    let dist = distance(character, target);
    if (dist > character.range) {
        if (!character.moving) move(target.x, target.y);
    } else if (can_attack(target)) {
        attack(target);
    }
}, CONFIG.loopInterval);

// --- QUARTERMASTER REQUEST ROUTINE ---
let lastDeliveryRequest = 0;

function countItem(name) {
    let total = 0;
    for (let slot of character.items) {
        if (slot && slot.name === name) total += slot.q || 1;
    }
    return total;
}

function checkPotionStock() {
    if (character.rip) return;

    let hpStock = countItem("hpot1");
    let mpStock = countItem("mpot1");

    if ((hpStock < 2000 || mpStock < 2000) && Date.now() - lastDeliveryRequest > 60000) {
        send_cm("SuperSellin", {
            action: "request_potions",
            hpNeeded: Math.max(0, 5000 - hpStock),
            mpNeeded: Math.max(0, 5000 - mpStock),
            x: character.x,
            y: character.y,
            map: character.map
        });
        lastDeliveryRequest = Date.now();
        set_message("Requested Pots");
    }
}

setInterval(checkPotionStock, 10000);