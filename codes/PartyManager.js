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

// Re-send an invite/request at most this often per character, so an unaccepted one
// doesn't pop up on the other character every few seconds.
var PARTY_RETRY_MS = 15000;
var partyLastSent = {};

function partyThrottled(key) {
    let now = Date.now();
    if (partyLastSent[key] && now - partyLastSent[key] < PARTY_RETRY_MS) return true;
    partyLastSent[key] = now;
    return false;
}

function maintainParty() {
    if (character.rip) return;

    if (character.name === PARTY_CONFIG.leader) {
        let currentParty = get_party() || {};
        for (let name of PARTY_CONFIG.members) {
            if (name === character.name || currentParty[name]) continue;
            if (get_player(name) && !partyThrottled("invite:" + name)) {
                send_party_invite(name).catch(function () {});
            }
        }
    } else if (character.party !== PARTY_CONFIG.leader) {
        if (character.party) leave_party(); // in the wrong party - bail out first
        else if (get_player(PARTY_CONFIG.leader) && !partyThrottled("request")) {
            send_party_request(PARTY_CONFIG.leader).catch(function () {});
        }
    }
}
setInterval(maintainParty, 3000);

function on_party_invite(name) {
    if (PARTY_CONFIG.members.includes(name)) accept_party_invite(name);
}
function on_party_request(name) {
    if (PARTY_CONFIG.members.includes(name)) accept_party_request(name);
}
