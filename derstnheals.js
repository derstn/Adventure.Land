// --- PRIEST SCRIPT (DerstnHeals) ---
performance_trick();

const CONFIG = {
    loopInterval: 250,
    lootInterval: 500,
    tankName: "DerstnTanks",
    merchantName: "SuperSellin",
    healThreshold: 0.85,
    partyHealThreshold: 0.65,
    followDistance: 110
};

// Periodic auto-looting
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

// Potion Counter Helper
function countItem(name) {
    let total = 0;
    for (let slot of character.items) {
        if (slot && slot.name === name) total += slot.q || 1;
    }
    return total;
}

function managePotions() {
    if (is_on_cooldown("use_hp")) return;
    if (character.hp < character.max_hp * 0.6) use_skill("use_hp");
    else if (character.mp < character.max_mp * 0.4) use_skill("use_mp");
    else if (character.mp < character.max_mp) use_skill("regen_mp");
}

function getLowestPartyMember() {
    let lowest = character;
    let lowestPct = character.hp / character.max_hp;

    for (let name of parent.party_list) {
        let member = get_player(name);
        if (!member || member.rip) continue;

        let pct = member.hp / member.max_hp;
        if (pct < lowestPct) {
            lowestPct = pct;
            lowest = member;
        }
    }
    return { member: lowest, pct: lowestPct };
}

function handleFollow(tank) {
    if (!tank || tank.rip) return;

    let dist = distance(character, tank);
    let targetX = tank.x + 35;
    let targetY = tank.y - 35;

    if (dist > CONFIG.followDistance) {
        if (!character.moving || distance(character, { x: targetX, y: targetY }) > 20) {
            move(targetX, targetY);
        }
    }
}

// Main Priest Loop
setInterval(() => {
    managePotions();
    if (character.rip) return;

    let tank = get_player(CONFIG.tankName);

    // Follow tank formation
    handleFollow(tank);

    // 1. Healing Priority (takes precedence over damage even while moving)
    let targetHeal = getLowestPartyMember();

    if (targetHeal.pct < CONFIG.partyHealThreshold && !is_on_cooldown("partyheal") && character.mp >= 400) {
        use_skill("partyheal");
        return;
    }

    if (targetHeal.pct < CONFIG.healThreshold && !is_on_cooldown("heal")) {
        if (distance(character, targetHeal.member) <= character.range) {
            heal(targetHeal.member);
            return;
        }
    }

    // 2. DPS Assist if party is stable
    if (tank) {
        let mob = get_target_of(tank);
        if (mob && can_attack(mob) && distance(character, mob) <= character.range) {
            attack(mob);
        }
    }
}, CONFIG.loopInterval);

// --- QUARTERMASTER REQUEST ROUTINE ---
let lastDeliveryRequest = 0;

function checkPotionStock() {
    if (character.rip) return;

    let hpStock = countItem("hpot1");
    let mpStock = countItem("mpot1");

    // Request restock when under 2000, target 5000 (rate-limited to every 60s)
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