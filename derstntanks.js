// --- WARRIOR SCRIPT (DerstnTanks) ---
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
    merchantName: "SuperSellin",
    targetTypes: ["phoenix", "snake", "osnake"], // Update to your active mob
    partyMembers: ["Derstn", "DerstnHeals", "DerstnMage", "SuperSellin"]
};

setInterval(() => { loot(); }, CONFIG.lootInterval);

// Survival Potions
function managePotions() {
    if (is_on_cooldown("use_hp")) return;
    if (character.hp < character.max_hp * 0.7) use_skill("use_hp");
    else if (character.mp < character.max_mp * 0.3) use_skill("use_mp");
    else if (character.hp < character.max_hp) use_skill("regen_hp");
}

// Hard Shell: reactive self-mitigation, only fired when HP is actually dropping fast
// (not on cooldown regardless of danger) since the party leans on Taunt to avoid damage entirely.
const HARDSHELL_HP_THRESHOLD = 0.5;

function manageHardShell() {
    if (is_on_cooldown("hardshell")) return;
    const cost = (G.skills.hardshell && G.skills.hardshell.mp) || 480;
    if (character.mp < cost) return;
    if (character.hp < character.max_hp * HARDSHELL_HP_THRESHOLD) {
        use_skill("hardshell");
    }
}

// Elixir Maintenance: keep elixirstr0 equipped, re-equip from bags if it falls off
function maintainElixir() {
    try {
        const requiredElixir = "elixirstr0";
        const currentElixir = character.slots.elixir?.name;
        if (currentElixir !== requiredElixir) {
            let slot = locate_item(requiredElixir);
            if (slot !== -1) {
                use(slot);
            } else {
                game_log("Out of " + requiredElixir + "!");
            }
        }
    } catch (e) { console.error("Error in maintainElixir:", e); }
}
setInterval(maintainElixir, 5000);

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

    manageHardShell();
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