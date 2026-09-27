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
load_code("LiveConfig"); // optional private slot written by tools/telemetry_dashboard.py --serve; enables live push
load_code("Telemetry"); // farm metrics for the dashboard; starts timers, load once

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

function checkAggro() {
    if (is_on_cooldown("taunt") || character.mp < 40) return;

    let protect = FARM_CONFIG.mode === "free_for_all"
        ? endangeredMembers(PEEL_HP_THRESHOLD)
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

// Agitate: the AoE version of Taunt - grabs every nearby monster in one call instead of picking
// them off one at a time. Risky: it can just as easily grab a powerful spawn nobody meant to pull
// and overwhelm the party, so it's opt-in only (FARM_CONFIG.agitateEnabled, off by default) and only
// in free_for_all (support_tank already gets full coverage from single-target Taunt/checkAggro).
function manageAgitate() {
    if (!FARM_CONFIG.agitateEnabled || FARM_CONFIG.mode !== "free_for_all" || !skillUnlocked("agitate")) return false;
    if (is_on_cooldown("agitate")) return false;
    const cost = (G.skills.agitate && G.skills.agitate.mp) || 420;
    if (!canSpendMp(cost, MP_CONFIG.warriorSkillReserve)) return false;
    const range = (G.skills.agitate && G.skills.agitate.range) || 320;

    let loose = 0;
    for (let id in parent.entities) {
        let mob = parent.entities[id];
        if (mob.type !== "monster" || mob.dead) continue;
        if (mob.target === character.name) continue; // already ours
        if (distance(character, mob) <= range) loose++;
    }
    if (loose < 2) return false;
    use_skill("agitate");
    return true;
}

// Stomp: AoE stun, best spent as crowd control on a big pull rather than held in reserve.
// Only works with a basher ("hammer"-type weapon) equipped - same weapon-type gate as Cleave.
function manageStomp() {
    if (!skillUnlocked("stomp")) return false;
    let weapon = character.slots.mainhand;
    let wtype = weapon && G.items[weapon.name] && G.items[weapon.name].wtype;
    if (wtype !== "basher") return false;
    if (is_on_cooldown("stomp")) return false;
    const cost = (G.skills.stomp && G.skills.stomp.mp) || 120;
    if (!canSpendMp(cost, MP_CONFIG.warriorSkillReserve)) return false;
    const range = (G.skills.stomp && G.skills.stomp.range) || 400;

    let nearby = 0;
    for (let id in parent.entities) {
        let mob = parent.entities[id];
        if (mob.type === "monster" && !mob.dead && distance(character, mob) <= range) nearby++;
    }
    if (nearby < 3) return false;
    use_skill("stomp");
    return true;
}

// War Cry: self-centered party buff (+attack speed, +move speed, +armor, +resistance). Free value -
// fire it whenever it's up and we can afford it, no situational gating needed.
function manageWarCry() {
    if (!skillUnlocked("warcry")) return false;
    if (is_on_cooldown("warcry")) return false;
    const cost = (G.skills.warcry && G.skills.warcry.mp) || 320;
    if (!canSpendMp(cost, MP_CONFIG.warriorSkillReserve)) return false;
    use_skill("warcry");
    return true;
}

// Cleave: AoE melee damage. Only worth using over a plain attack with 2+ targets in range, and only
// with an axe/scythe equipped (the only weapon types it works with).
function manageCleave(primaryTarget) {
    if (!skillUnlocked("cleave")) return false;
    let weapon = character.slots.mainhand;
    let wtype = weapon && G.items[weapon.name] && G.items[weapon.name].wtype;
    if (wtype !== "axe" && wtype !== "scythe") return false;
    if (is_on_cooldown("cleave")) return false;
    const cost = (G.skills.cleave && G.skills.cleave.mp) || 720;
    if (!canSpendMp(cost, MP_CONFIG.warriorSkillReserve)) return false;
    const range = (G.skills.cleave && G.skills.cleave.range) || 160;

    let extras = 0;
    for (let id in parent.entities) {
        let mob = parent.entities[id];
        if (mob.type === "monster" && !mob.dead && mob.id !== primaryTarget.id && distance(character, mob) <= range) extras++;
    }
    if (extras < 1) return false;
    use_skill("cleave");
    return true;
}

// Charge: free (0 mp) speed burst, spent to close a large gap faster instead of walking it.
function manageCharge(dist) {
    if (is_on_cooldown("charge")) return false;
    if (dist < 400) return false;
    use_skill("charge");
    return true;
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
    if (manageStomp()) return;   // CC a big pull before anything else
    if (manageAgitate()) return; // consolidate loose aggro (support_tank only)
    checkAggro();                // single-target peel
    if (manageWarCry()) return;  // party buff, whenever it's up

    let target = getValidTankTarget();
    if (!target) return;

    if (get_targeted_monster() !== target) {
        change_target(target);
    }

    let dist = distance(character, target);
    if (dist > character.range) {
        manageCharge(dist);
        if (!character.moving) move(target.x, target.y);
    } else if (can_attack(target)) {
        if (!manageCleave(target)) attack(target);
    }
}, CONFIG.loopInterval);