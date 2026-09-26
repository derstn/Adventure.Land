// --- PRIEST SCRIPT (DerstnHeals) ---
performance_trick();

// Shared account CODE slots (see adventureland/codes/): party management,
// merchant mule offload, and potion-request logic are identical across
// characters, so they live in one place instead of being copy-pasted.
load_code("PartyManager");
load_code("Utils");
load_code("CombatSupport");

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

    if (targetHeal.pct < CONFIG.healThreshold && can_heal(targetHeal.member)) {
        heal(targetHeal.member);
        return;
    }

    // 2. DPS Assist if party is stable
    if (tank) {
        let mob = get_target_of(tank);
        if (mob && can_attack(mob) && distance(character, mob) <= character.range) {
            attack(mob);
        }
    }
}, CONFIG.loopInterval);