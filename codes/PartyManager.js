// --- SHARED: PARTY MANAGEMENT ---
// Account CODE slot, loaded via load_code("PartyManager") from every character script.
// Uses `var` (not const/let) at top level since load_code re-executes the file
// on every call, and redeclaring a top-level const/let throws if this ever runs twice.
//
// character.party holds the LEADER'S name once a party exists (server sets
// inviter.party = inviter.name on first accept), so that's the reliable way
// to check "am I in the right party" - not the .in field (that's map/instance).
var PARTY_CONFIG = {
    leader: "Derstn",
    members: ["Derstn", "DerstnHeals", "DerstnTanks", "SuperSellin"]
};

function maintainParty() {
    if (character.rip) return;

    if (character.name === PARTY_CONFIG.leader) {
        let currentParty = get_party() || {};
        for (let name of PARTY_CONFIG.members) {
            if (name === character.name || currentParty[name]) continue;
            if (get_player(name)) send_party_invite(name);
        }
    } else if (character.party !== PARTY_CONFIG.leader) {
        if (character.party) leave_party(); // in the wrong party - bail out first
        else if (get_player(PARTY_CONFIG.leader)) send_party_request(PARTY_CONFIG.leader);
    }
}
setInterval(maintainParty, 3000);

function on_party_invite(name) {
    if (PARTY_CONFIG.members.includes(name)) accept_party_invite(name);
}
function on_party_request(name) {
    if (PARTY_CONFIG.members.includes(name)) accept_party_request(name);
}
