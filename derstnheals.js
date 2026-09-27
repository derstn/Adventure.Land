// --- PRIEST SCRIPT (DerstnHeals) ---
performance_trick();
mode_resolve_all(); // action failures (cooldown, out of range) fulfill with {failed, reason} instead of rejecting unhandled

// Shared account CODE slots (see adventureland/codes/): party management,
// merchant mule offload, and potion-request logic are identical across
// characters, so they live in one place instead of being copy-pasted.
load_code("PartyManager");
load_code("Utils");
load_code("Targets");
load_code("CombatSupport");
load_code("LiveConfig"); // optional private slot written by tools/telemetry_dashboard.py --serve; enables live push
load_code("Telemetry"); // farm metrics for the dashboard; starts timers, load once

const CONFIG = {
    loopInterval: 250,
    lootInterval: 500,
    tankName: "DerstnTanks",
    merchantName: "SuperSellin",
    healThreshold: 0.85,
    partyHealThreshold: 0.65
};

// Periodic auto-looting
setInterval(() => { loot(); }, CONFIG.lootInterval);

function managePotions() {
    if (is_on_cooldown("use_hp")) return;
    if (character.hp < character.max_hp * 0.6) use_skill("use_hp");
    else if (character.mp < character.max_mp * MP_CONFIG.potionBelow) use_skill("use_mp");
    else if (character.mp < character.max_mp) use_skill("regen_mp");
}

// Absorb Sins: pulls a struggling ally's aggro onto the priest. Only worth it when someone else is
// in real danger (not just "below heal threshold") and the priest itself is healthy enough to eat
// the aggro without becoming the next casualty.
const ABSORB_HP_THRESHOLD = 0.35;
const ABSORB_SELF_SAFE = 0.65;

function manageAbsorb() {
    if (!skillUnlocked("absorb") || is_on_cooldown("absorb")) return false;
    if (character.hp < character.max_hp * ABSORB_SELF_SAFE) return false;
    const cost = (G.skills.absorb && G.skills.absorb.mp) || 200;
    if (!canSpendMp(cost, MP_CONFIG.supportSkillReserve)) return false;
    const range = (G.skills.absorb && G.skills.absorb.range) || 240;

    for (let name of endangeredMembers(ABSORB_HP_THRESHOLD)) {
        let member = get_player(name);
        if (member && distance(character, member) <= range) {
            use_skill("absorb", member);
            return true;
        }
    }
    return false;
}

// Curse: -20% enemy damage dealt, +20% damage it takes from everyone, -20 speed. Cooldown equals
// duration (5s/5s) so it's worth maintaining on the shared farm target essentially every tick it's
// off cooldown - it's a party-wide damage multiplier for one cheap cast, not just a priest DPS tool.
function manageCurse(mob) {
    if (!mob || mob.dead || is_on_cooldown("curse")) return false;
    const cost = (G.skills.curse && G.skills.curse.mp) || 400;
    if (!canSpendMp(cost, MP_CONFIG.supportSkillReserve)) return false;
    const range = (G.skills.curse && G.skills.curse.range) || 200;
    if (distance(character, mob) > range) return false;
    use_skill("curse", mob);
    return true;
}

// Dark Blessing: self-centered party damage buff (+25% output, 8s, 60s cooldown). Pure upside -
// fire it whenever it's up and affordable.
function manageDarkBlessing() {
    if (!skillUnlocked("darkblessing") || is_on_cooldown("darkblessing")) return false;
    const cost = (G.skills.darkblessing && G.skills.darkblessing.mp) || 900;
    if (!canSpendMp(cost, MP_CONFIG.supportSkillReserve)) return false;
    use_skill("darkblessing");
    return true;
}

function getLowestPartyMember() {
    let lowest = character;
    let lowestPct = character.hp / character.max_hp;

    for (let name of partyNames()) {
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

// Main Priest Loop
setInterval(() => {
    managePotions();
    if (character.rip) return;

    let tank = get_player(CONFIG.tankName);

    let targetHeal = getLowestPartyMember();

    let mob = null;
    if (FARM_CONFIG.mode === "free_for_all") {
        mob = tank && !tank.rip
            ? nearestFarmMobNear(tank, STATION_CONFIG.freeForAllLeash)
            : nearestFarmMob(character.range);
    } else {
        mob = tank && get_target_of(tank);
    }

    // Positioning rules live in the shared Targets slot. In free_for_all, break off hunting
    // to walk back toward a party member who needs a heal but is out of heal range.
    let needsHealWalk = targetHeal.member !== character && targetHeal.pct < CONFIG.healThreshold
        && !can_heal(targetHeal.member);
    priestStation(tank, mob, needsHealWalk ? targetHeal.member : null);

    // 1. Healing Priority (takes precedence over damage even while moving)

    const partyHealCost = (G.skills.partyheal && G.skills.partyheal.mp) || 400;
    if (targetHeal.pct < CONFIG.partyHealThreshold && !is_on_cooldown("partyheal") && canSpendMp(partyHealCost, MP_CONFIG.supportSkillReserve)) {
        use_skill("partyheal");
        return;
    }

    if (targetHeal.pct < CONFIG.healThreshold && can_heal(targetHeal.member)) {
        heal(targetHeal.member);
        return;
    }

    // 2. Emergency peel - save a dying ally before doing anything offensive
    if (manageAbsorb()) return;

    // 3. Curse - keep the shared farm target cursed (party-wide dmg multiplier)
    if (mob && !mob.dead && manageCurse(mob)) return;

    // 4. Dark Blessing - party damage buff, whenever it's up
    if (manageDarkBlessing()) return;

    // 5. DPS if party is stable
    if (mob && !mob.dead && character.mp >= character.max_mp * MP_CONFIG.supportAttackReserve
        && can_attack(mob) && distance(character, mob) <= character.range) {
        attack(mob);
    }
}, CONFIG.loopInterval);