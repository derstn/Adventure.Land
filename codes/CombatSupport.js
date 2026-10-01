// --- SHARED: MULE OFFLOAD + POTION REQUESTS ---
// Account CODE slot, loaded via load_code("CombatSupport") from the ranger, priest,
// and warrior scripts only (NOT the merchant - it's the recipient of these calls,
// not a participant). Requires countItem(), so load_code("Utils") first.
var MULE_CONFIG = {
    merchantName: "SuperSellin",
    goldReserve: 50000,
    transferDistance: 250,
    keepItems: ["tracker", "hpot1", "mpot1"]
};

var lastFullBagAlert = 0;

function offloadToMerchant() {
    if (character.rip) return;

    let merchant = get_player(MULE_CONFIG.merchantName);

    // If merchant is nearby, dump up to 6 items per second instead of just 1
    if (merchant && distance(character, merchant) <= MULE_CONFIG.transferDistance) {
        // Offload gold
        if (character.gold > MULE_CONFIG.goldReserve + 20000) {
            send_gold(MULE_CONFIG.merchantName, character.gold - MULE_CONFIG.goldReserve);
        }

        let sent = 0;
        for (let i = 0; i < character.items.length; i++) {
            let item = character.items[i];
            if (!item || MULE_CONFIG.keepItems.includes(item.name)) continue;

            send_item(MULE_CONFIG.merchantName, i, item.q || 1);
            sent++;
            if (sent >= 6) break; // Burst send to clear bags during the merchant's visit
        }
    }

    // Call for pickup on-demand if bags have 6 or fewer empty slots left
    let emptySlots = character.items.filter(i => !i).length;
    if (emptySlots <= 6 && Date.now() - lastFullBagAlert > 60000) {
        send_cm(MULE_CONFIG.merchantName, {
            action: "request_pickup",
            x: character.x,
            y: character.y,
            map: character.map
        });
        lastFullBagAlert = Date.now();
        set_message("Bag Full! Called Mule");
    }
}
setInterval(offloadToMerchant, 500);

// --- QUARTERMASTER REQUEST ROUTINE ---
// potionRequestSentAt tracks the CURRENT low-stock episode, not just "time since last send" - a flat
// 60s throttle was the actual bug: a real restock round-trip (merchant closes stand, buys, travels,
// delivers) can easily take longer than that, so checkPotionStock (every 10s) would fire again and
// re-request BEFORE the first delivery ever arrived, queuing a second full delivery for potions that
// were already on their way - that's what produced two ~3000-potion runs back to back. Clearing the
// flag only once stock is confirmed to have actually recovered (not just "60s elapsed") means no
// second request can go out while the first is still in flight, no matter how long that trip takes.
// A long fallback (5 min, well past any real round-trip) still allows a retry if the CM message
// itself was ever lost (delivery, not just request, is never guaranteed - see the code-messages doc).
var potionRequestSentAt = 0; // 0 = no outstanding request

function checkPotionStock() {
    if (character.rip) return;

    let hpStock = countItem("hpot1");
    let mpStock = countItem("mpot1");
    let low = hpStock < 1500 || mpStock < 1500;

    if (!low) {
        if (potionRequestSentAt) set_message(""); // clear the stale "Requested Pots" label now that it's resolved
        potionRequestSentAt = 0;
        return;
    }
    if (potionRequestSentAt && Date.now() - potionRequestSentAt < 5 * 60 * 1000) return;

    // Flat top-off instead of "fill to 5000": simpler, and potions stack high enough that overshooting
    // a bit costs nothing - the goal is not running this again for a long while, not precise accounting.
    send_cm("SuperSellin", {
        action: "request_potions",
        hpNeeded: hpStock < 1500 ? 9999 : 0,
        mpNeeded: mpStock < 1500 ? 9999 : 0,
        x: character.x,
        y: character.y,
        map: character.map
    });
    potionRequestSentAt = Date.now();
    set_message("Requested Pots");
}
setInterval(checkPotionStock, 10000);
