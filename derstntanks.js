// --- WARRIOR SCRIPT (DerstnTanks) ---
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
    merchantName: "SuperSellin"
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

// Aggro Control (Taunt). support_tank: peel every mob attacking a party member.
// free_for_all: pure damage - only peel mobs attacking a member whose HP is low.
const PEEL_HP_THRESHOLD = 0.5;
let lastPeelId = null;

function endangeredMembers() {
    let names = [];
    for (let name of partyNames()) {
        if (name === character.name) continue;
        let member = get_player(name);
        if (member && !member.rip && member.hp / member.max_hp < PEEL_HP_THRESHOLD) names.push(name);
    }
    return names;
}

function checkAggro() {
    if (is_on_cooldown("taunt") || character.mp < 40) return;

    let protect = FARM_CONFIG.mode === "free_for_all"
        ? endangeredMembers()
        : PARTY_CONFIG.members.filter(name => name !== character.name);
    if (!protect.length) return;

    for (let id in parent.entities) {
        let entity = parent.entities[id];
        if (entity.type !== "monster" || entity.dead) continue;

        if (protect.includes(entity.target) && distance(character, entity) <= 200) {
            use_skill("taunt", entity);
            change_target(entity);
            lastPeelId = entity.id;
            return;
        }
    }
}

// Target Selection (type list + outsider-tag filtering live in the shared Targets slot).
// support_tank: sticky on the current valid target, otherwise nearest valid farm mob.
// free_for_all: pure damage - go for mobs nobody has aggro on; only fall back to a mob
// already aggroed on a party member when nothing free is visible (or a Taunt peel picked it).
function isUnclaimed(mob) {
    return !mob.target || mob.target === character.name;
}

function getValidTankTarget() {
    let current = get_targeted_monster();
    if (FARM_CONFIG.mode !== "free_for_all") {
        if (isValidFarmMob(current)) return current;
        return nearestFarmMob();
    }

    if (isValidFarmMob(current) && (isUnclaimed(current) || current.id === lastPeelId)) return current;
    return nearestFarmMob(null, isUnclaimed) || nearestFarmMob();
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