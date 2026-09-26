// --- SHARED: MISC HELPERS ---
// Account CODE slot, loaded via load_code("Utils") from every character script.

function countItem(name) {
    let total = 0;
    for (let slot of character.items) {
        if (slot && slot.name === name) total += slot.q || 1;
    }
    return total;
}

// Names of everyone in the current party (including this character).
function partyNames() {
    return Object.keys(get_party() || {});
}
