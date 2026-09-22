// --- RANGER SCRIPT (Derstn) ---
performance_trick();

const CONFIG = {
    loopInterval: 250,
    lootInterval: 500,
    tankName: "DerstnTanks",
    merchantName: "SuperSellin",
    targetTypes: ["scorpion"],
    useSupershot: true,
    usePiercingShot: true,
    followDistance: 120, // Start following if tank gets further than this
    stopDistance: 80     // Stop following once within this radius
};

let lastHuntersMarkTime = 0;

// Looting
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

// Survival
function managePotions() {
    if (is_on_cooldown("use_hp")) return;
    const hpGain = (G.items.hpot1 && G.items.hpot1.gives[0][1]) || 400;
    const mpGain = (G.items.mpot1 && G.items.mpot1.gives[0][1]) || 500;

    if (character.hp < character.max_hp * 0.7) {
        use_skill("use_hp");
        return;
    }
    if (character.hp <= character.max_hp - hpGain) {
        use_skill("use_hp");
        return;
    }
    if (character.mp <= character.max_mp - mpGain && character.hp > character.max_hp * 0.85) {
        use_skill("use_mp");
        return;
    }
    if (character.hp < character.max_hp) use_skill("regen_hp");
    else if (character.mp < character.max_mp) use_skill("regen_mp");
}

// Follow Tank Formation
function handleFollow(tank) {
    if (!tank || tank.rip) return false;

    let dist = distance(character, tank);
    let targetX = tank.x - 35;
    let targetY = tank.y - 35;

    // Follow if tank pulled away
    if (dist > CONFIG.followDistance) {
        if (!character.moving || distance(character, { x: targetX, y: targetY }) > 20) {
            move(targetX, targetY);
        }
        return true; // Busy catching up
    }
    return false;
}

// Target Resolution: Assist Tank
function getTarget(tank) {
    if (tank) {
        let tankTarget = get_target_of(tank);
        if (tankTarget && !tankTarget.dead) return tankTarget;
    }

    let current = get_targeted_monster();
    if (current && !current.dead && distance(character, current) <= character.range) {
        return current;
    }

    return get_nearest_monster({ type: CONFIG.targetTypes[0] });
}

// Combat Skills
function handleSkills(target) {
    const now = Date.now();
    const dist = distance(character, target);

    // Hunter's Mark
    const markCost = (G.skills.huntersmark && G.skills.huntersmark.mp) || 240;
    if (!is_on_cooldown("huntersmark") && character.mp >= markCost && dist <= character.range) {
        if (!target.s?.marked || (now - lastHuntersMarkTime >= 10000)) {
            use_skill("huntersmark", target);
            lastHuntersMarkTime = now;
            return;
        }
    }

    // Supershot
    if (CONFIG.useSupershot) {
        const superCost = (G.skills.supershot && G.skills.supershot.mp) || 400;
        if (!is_on_cooldown("supershot") && character.mp >= superCost && dist <= (character.range * 1.5)) {
            use_skill("supershot", target);
            return;
        }
    }

    // Piercing Shot
    if (CONFIG.usePiercingShot) {
        const pierceCost = (G.skills.piercingshot && G.skills.piercingshot.mp) || 64;
        if (!is_on_cooldown("piercingshot") && character.mp >= pierceCost && dist <= character.range) {
            use_skill("piercingshot", target);
            return;
        }
    }
}

// Ranger Main Loop
setInterval(() => {
    managePotions();
    if (character.rip) return;

    let tank = get_player(CONFIG.tankName);

    // Prioritize catching up to tank if moving across map
    let isCatchingUp = handleFollow(tank);
    if (isCatchingUp && distance(character, tank) > CONFIG.followDistance * 1.5) {
        return; // Don't stop to shoot if tank is running far ahead
    }

    let target = getTarget(tank);
    if (!target) return;

    if (get_targeted_monster() !== target) change_target(target);

    handleSkills(target);

    if (can_attack(target) && distance(character, target) <= character.range) {
        attack(target);
    }
}, CONFIG.loopInterval);

// --- QUARTERMASTER REQUEST ROUTINE ---
let lastDeliveryRequest = 0;

// Potion Counter Helper
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