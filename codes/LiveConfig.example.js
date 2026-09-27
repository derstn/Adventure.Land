// --- EXAMPLE: live push settings (NOT the real file) ---
// The real slot is generated for you: `py tools/telemetry_dashboard.py --serve` writes
// adventureland/codes/LiveConfig.8.js (gitignored, uploaded as account CODE slot 8, "LiveConfig")
// containing a random secret. Never commit a real secret. Without that slot the Telemetry module
// simply does not push anything live.
var LIVE_CONFIG = {
    url: "http://127.0.0.1:8765",
    secret: "generated-by-the-tool"
};
