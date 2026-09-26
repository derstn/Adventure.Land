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
var lastDeliveryRequest = 0;

function checkPotionStock() {
    if (character.rip) return;

    let hpStock = countItem("hpot1");
    let mpStock = countItem("mpot1");

    // Request restock when under 2000, target 5000 (rate-limited to every 60s)
    if ((hpStock < 2000 || mpStock < 2000) && Date.now() - lastDeliveryRequest > 60000) {
        send_cm("SuperSellin", {
            action: "request_potions",
            hpNeeded: Math.max(0, 5000 - hpStock),
            mpNeeded: Math.max(0, 5000 - mpStock),
            x: character.x,
            y: character.y,
            map: character.map
        });
        lastDeliveryRequest = Date.now();
        set_message("Requested Pots");
    }
}
setInterval(checkPotionStock, 10000);
