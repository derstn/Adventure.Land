// --- RANGER SCRIPT (Derstn) ---
performance_trick();
mode_resolve_all(); // action failures (cooldown, out of range) fulfill with {failed, reason} instead of rejecting unhandled

// Shared account CODE slots (see adventureland/codes/): party management,
// merchant mule offload, and potion-request logic are identical across
// characters, so they live in one place instead of being copy-pasted.
load_code("PartyManager");
load_code("Utils");
load_code("Targets");
load_code("CombatSupport");

const CONFIG = {
    loopInterval: 250,
    lootInterval: 500,
    tankName: "DerstnTanks",
    merchantName: "SuperSellin",
    useSupershot: true,
    use3shot: true,
};

let lastHuntersMarkTime = 0;

// Looting
setInterval(() => { loot(); }, CONFIG.lootInterval);

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

// Target Resolution: see FARM_CONFIG.mode in the shared Targets slot
function getTarget(tank) {
    if (FARM_CONFIG.mode === "free_for_all") {
        // Hunt the nearest snake inside the roam circle around the tank (walking to it if needed)
        if (!tank || tank.rip) return nearestFarmMob(character.range);
        let roam = STATION_CONFIG.freeForAllLeash;
        let current = get_targeted_monster();
        if (isValidFarmMob(current) && distance(tank, current) <= roam) return current;
        return nearestFarmMobNear(tank, roam);
    }

    // support_tank: only ever attack what the tank is attacking
    if (tank) {
        let tankTarget = get_target_of(tank);
        if (tankTarget && !tankTarget.dead) return tankTarget;
    }
    return null;
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

    // Supershot — real range is character.range * range_multiplier + range_bonus (3x + 20), not 1.5x
    if (CONFIG.useSupershot) {
        const superSkill = G.skills.supershot || {};
        const superCost = superSkill.mp || 400;
        const superRange = character.range * (superSkill.range_multiplier || 3) + (superSkill.range_bonus || 20);
        if (!is_on_cooldown("supershot") && character.mp >= superCost && dist <= superRange) {
            use_skill("supershot", target);
            return;
        }
    }

    // 3-Shot — deals 0.7x damage per target, so it's only a DPS gain with 2+ monsters in range.
    // Against a single target it's strictly worse than a normal attack (0.7x vs 1x), so skip it there.
    if (CONFIG.use3shot) {
        const cost3Shot = (G.skills["3shot"] && G.skills["3shot"].mp) || 200;

        if (!is_on_cooldown("3shot") && character.mp >= cost3Shot && dist <= character.range) {
            // In support_tank mode, extra targets must already be aggroed on the tank.
            let onlyTargeting = FARM_CONFIG.mode === "support_tank" ? CONFIG.tankName : null;
            let extras = farmMobsInRange(character.range - 2, 2, onlyTargeting, target.id);

            if (extras.length >= 1) {
                use_skill("3shot", [target].concat(extras));
                return;
            }
        }
    }
}

// Ranger Main Loop
setInterval(() => {
    managePotions();
    if (character.rip) return;

    let tank = get_player(CONFIG.tankName);
    let target = getTarget(tank);

    // Stay with the tank (positioning rules live in the shared Targets slot)
    rangerStation(tank, target);
    if (tooFarFromTank(tank)) return; // Don't stop to shoot if the tank is running far ahead

    if (!target) return;

    if (get_targeted_monster() !== target) change_target(target);

    handleSkills(target);

    if (can_attack(target) && distance(character, target) <= character.range) {
        attack(target);
    }
}, CONFIG.loopInterval);