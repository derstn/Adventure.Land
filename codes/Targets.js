// --- SHARED: FARM TARGETS ---
// Account CODE slot, loaded via load_code("Targets") from the ranger, priest, and
// warrior scripts. Requires partyNames(), so load_code("Utils") first.
// `var` at top level because load_code re-executes the file on every call.
var FARM_CONFIG = {
    // "support_tank": ranger + priest only hit whatever the warrior is targeting.
    // "free_for_all": everyone picks the nearest valid farm mob on their own.
    mode: "support_tank",
    targetTypes: ["phoenix", "snake", "osnake"]
};

// A monster we're willing to fight: right type, alive, and not locked onto a
// player outside our party.
function isValidFarmMob(mob) {
    if (!mob || mob.dead || mob.type !== "monster" || mob.visible === false) return false;
    if (!FARM_CONFIG.targetTypes.includes(mob.mtype)) return false;
    return !mob.target || mob.target === character.name || partyNames().includes(mob.target);
}

// Optional filter(mob) narrows the candidates further (e.g. only mobs nobody has aggro on).
function nearestFarmMob(maxRange, filter) {
    let best = null;
    let bestDist = Infinity;
    for (let id in parent.entities) {
        let mob = parent.entities[id];
        if (!isValidFarmMob(mob) || (filter && !filter(mob))) continue;
        let d = distance(character, mob);
        if (d < bestDist && (!maxRange || d <= maxRange)) {
            best = mob;
            bestDist = d;
        }
    }
    return best;
}

// Nearest valid farm mob (to this character) that is within r of center, e.g. the tank.
function nearestFarmMobNear(center, r) {
    let best = null;
    let bestDist = Infinity;
    for (let id in parent.entities) {
        let mob = parent.entities[id];
        if (!isValidFarmMob(mob) || distance(center, mob) > r) continue;
        let d = distance(character, mob);
        if (d < bestDist) {
            best = mob;
            bestDist = d;
        }
    }
    return best;
}

// Nearest-first list of valid farm mobs within range, for multi-target skills.
// onlyTargeting: restrict to mobs currently aggroed on that character name.
function farmMobsInRange(range, limit, onlyTargeting, excludeId) {
    let found = [];
    for (let id in parent.entities) {
        let mob = parent.entities[id];
        if (!isValidFarmMob(mob) || mob.id === excludeId) continue;
        if (onlyTargeting && mob.target !== onlyTargeting) continue;
        let d = distance(character, mob);
        if (d <= range) found.push({ mob: mob, d: d });
    }
    found.sort((a, b) => a.d - b.d);
    return found.slice(0, limit).map(f => f.mob);
}

// --- STATIONING: where the ranger and priest stand relative to the tank ---
var STATION_CONFIG = {
    freeForAllLeash: 400, // free_for_all: roam radius around the tank (ranger/priest hunt freely inside it)
    supportLeash: 120,    // support_tank: ranger's max distance from the tank
    rangeMargin: 15,      // stand this far inside max range so small drifts stay in range
    merchantName: "SuperSellin" // never anchor to the merchant, it patrols away
};

// Point to walk to so that we are within `reach` of `target` (if any) and inside
// every anchor circle {x, y, r}. Starts from the current position, so it returns
// null (no move) whenever we're already well placed.
function stationPoint(target, reach, anchors) {
    let p = { x: character.x, y: character.y };
    if (target) {
        let d = distance(p, target);
        if (d > reach) p = { x: target.x + (p.x - target.x) * reach / d, y: target.y + (p.y - target.y) * reach / d };
    }
    for (let pass = 0; pass < 2; pass++) {
        for (let a of anchors) {
            let d = distance(p, a);
            if (d > a.r) p = { x: a.x + (p.x - a.x) * a.r / d, y: a.y + (p.y - a.y) * a.r / d };
        }
    }
    return distance(character, p) > 8 ? p : null;
}

// True when the tank is far enough ahead that shooting should wait until we catch up.
function tooFarFromTank(tank) {
    if (!tank || tank.rip) return false;
    let leash = FARM_CONFIG.mode === "free_for_all" ? STATION_CONFIG.freeForAllLeash : STATION_CONFIG.supportLeash;
    return distance(character, tank) > leash * 1.5;
}

function moveToStation(p, tank) {
    if (!p) return;
    if (character.moving && distance({ x: character.going_x, y: character.going_y }, p) < 20) return;
    if (can_move_to(p.x, p.y)) move(p.x, p.y);
    else if (tank && distance(character, tank) > 200) xmove(tank.x, tank.y); // blocked and far behind: path around
}

// Visible living combat party members other than this character.
function partyStationAnchors(r) {
    let list = [];
    for (let name of partyNames()) {
        if (name === character.name || name === STATION_CONFIG.merchantName) continue;
        let p = get_player(name);
        if (p && !p.rip) list.push({ x: p.x, y: p.y, r: r });
    }
    return list;
}

// Ranger: stay with the tank. support_tank: within range of the tank's target.
// free_for_all: hug the tank and shoot whatever is in range.
function rangerStation(tank, target) {
    if (!tank || tank.rip) return;
    let reach = character.range - STATION_CONFIG.rangeMargin;
    let ffa = FARM_CONFIG.mode === "free_for_all";
    let anchors = [{ x: tank.x, y: tank.y, r: ffa ? STATION_CONFIG.freeForAllLeash : STATION_CONFIG.supportLeash }];
    moveToStation(stationPoint(target, reach, anchors), tank);
}

// Priest. support_tank: stay within heal range of the tank and every other combat party
// member, and within range of the tank's target so it can still attack.
// free_for_all: roam inside the tank's roam circle hunting `target`; if healMember is
// given (someone needs a heal and is out of heal range) go to them instead.
function priestStation(tank, target, healMember) {
    if (!tank || tank.rip) return;
    let reach = character.range - STATION_CONFIG.rangeMargin;
    if (FARM_CONFIG.mode === "free_for_all") {
        let roam = [{ x: tank.x, y: tank.y, r: STATION_CONFIG.freeForAllLeash }];
        moveToStation(stationPoint(healMember || target, reach, roam), tank);
        return;
    }
    let anchors = partyStationAnchors(reach);
    anchors.push({ x: tank.x, y: tank.y, r: reach });
    moveToStation(stationPoint(target, reach, anchors), tank);
}

// --- HOT RELOAD ---
// Re-run this slot every 60s so edits (mode, target list, positioning) apply without
// restarting CODE. Safe because this slot holds only config and functions - no timers
// or state to duplicate. The guard keeps a single reload timer no matter how often
// this file re-executes (var keeps its value across re-runs). A slot with a syntax
// error fails to run and leaves the previous definitions in place.
var targetsReloadTimer;
if (!targetsReloadTimer) {
    targetsReloadTimer = setInterval(function () { load_code("Targets"); }, 60000);
}
