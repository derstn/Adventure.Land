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
    // No forced home server: SuperSellin is deliberately server-hopped for merchant arbitrage, so
    // nothing here should ever navigate a character. Party invites are looked up by name on the
    // CURRENT server process only (node/server.js's "party" socket handler does
    // `players[name_to_id[name]]`, no cross-server lookup exists) - when a member is on a different
    // server than the leader, invites/requests just reject harmlessly (see maintainParty below) until
    // it's back on the same server as the rest of the party, with no action needed here.
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

// Invite/request purely by name - do NOT gate on get_player(name) (a VISIBLE-entity lookup only).
// The server's own invite/request handler has no visibility or same-map requirement at all, so
// requiring visibility here was the actual bug: a member logging in on a different map (town vs.
// the farm) or right after connecting (before anyone is in render range of anyone else) would
// never get invited, even though the server would have happily accepted the invite immediately.
function maintainParty() {
    if (character.rip) return;

    if (character.name === PARTY_CONFIG.leader) {
        let currentParty = get_party() || {};
        for (let name of PARTY_CONFIG.members) {
            if (name === character.name || currentParty[name]) continue;
            if (!partyThrottled("invite:" + name)) {
                send_party_invite(name).catch(function () {}); // rejects harmlessly if not online here
            }
        }
    } else if (character.party !== PARTY_CONFIG.leader) {
        if (character.party) leave_party(); // in the wrong party - bail out first
        else if (!partyThrottled("request")) {
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
