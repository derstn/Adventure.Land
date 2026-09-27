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
load_code("LiveConfig"); // optional private slot written by tools/telemetry_dashboard.py --serve; enables live push
load_code("Telemetry"); // farm metrics for the dashboard; starts timers, load once

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

    // HP and MP potions share one cooldown, so order matters: emergency HP first, then keep MP above the
    // skill reserve (MP_CONFIG in the Targets slot), and only then top off.
    if (character.hp < character.max_hp * 0.6) {
        use_skill("use_hp");
        return;
    }
    if (character.mp < character.max_mp * MP_CONFIG.potionBelow) {
        use_skill("use_mp");
        return;
    }
    if (character.hp <= character.max_hp - hpGain) {
        use_skill("use_hp");
        return;
    }
    if (character.mp <= character.max_mp - mpGain) {
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
    if (!is_on_cooldown("huntersmark") && canSpendMp(markCost, MP_CONFIG.dpsSkillReserve) && dist <= character.range) {
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
        if (!is_on_cooldown("supershot") && canSpendMp(superCost, MP_CONFIG.dpsSkillReserve) && dist <= superRange) {
            use_skill("supershot", target);
            return;
        }
    }

    // Multi-target shots — each deals less damage per target (5-Shot 0.5x, 3-Shot 0.7x), so they're
    // only a DPS gain with enough monsters in range; against a single target a normal attack wins.
    // Prefer 5-Shot (needs 4+ extras) over 3-Shot (needs 1+ extra) once it's unlocked.
    if (CONFIG.use3shot) {
        // In support_tank mode, extra targets must already be aggroed on the tank.
        let onlyTargeting = FARM_CONFIG.mode === "support_tank" ? CONFIG.tankName : null;

        if (skillUnlocked("5shot") && !is_on_cooldown("5shot") && dist <= character.range) {
            const cost5Shot = (G.skills["5shot"] && G.skills["5shot"].mp) || 500;
            if (canSpendMp(cost5Shot, MP_CONFIG.dpsSkillReserve)) {
                let extras = farmMobsInRange(character.range - 2, 4, onlyTargeting, target.id);
                if (extras.length >= 4) {
                    use_skill("5shot", [target].concat(extras));
                    return;
                }
            }
        }

        const cost3Shot = (G.skills["3shot"] && G.skills["3shot"].mp) || 200;
        if (!is_on_cooldown("3shot") && canSpendMp(cost3Shot, MP_CONFIG.dpsSkillReserve) && dist <= character.range) {
            let extras = farmMobsInRange(character.range - 2, 2, onlyTargeting, target.id);

            if (extras.length >= 1) {
                use_skill("3shot", [target].concat(extras));
                return;
            }
        }
    }
}

// Piercing Shot: shares the attack cooldown (not an extra skill cast) and pierces 500 armor at
// 0.75x damage - a straight upgrade over a normal attack against armored targets, but strictly worse
// against the current farm list (snake/osnake/phoenix all have ~0 armor), so it stays dormant until
// gated on target.armor. Wired in as a drop-in replacement for the final attack() call.
function tryPiercingShot(target) {
    if (!skillUnlocked("piercingshot") || (target.armor || 0) < 100) return false;
    const cost = (G.skills.piercingshot && G.skills.piercingshot.mp) || 64;
    if (!canSpendMp(cost, MP_CONFIG.dpsSkillReserve)) return false;
    if (!can_attack(target)) return false;
    use_skill("piercingshot", target);
    return true;
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
        if (!tryPiercingShot(target)) attack(target);
    }
}, CONFIG.loopInterval);