/**
 * Stream Director — main.mjs
 * Foundry VTT v13+
 *
 * Roles:
 *   "gm"       — GM window: free camera, never panned by others
 *   "player"   — Player window: own camera, never panned by others
 *   "operator" — Operator window: auto-follows moved tokens,
 *                jumps to the point where GM long-presses (ping)
 */

const MODULE_ID = "stream-director";
const SOCKET_NAME = `module.${MODULE_ID}`;

// ── helpers ──────────────────────────────────────────────────────────────────

function setting(key) {
  return game.settings.get(MODULE_ID, key);
}

function myRole() {
  const operatorId = setting("operatorUserId")?.trim();
  if (operatorId && game.user.id === operatorId) return "operator";
  return setting("role");
}

function isOperator() { return myRole() === "operator"; }
function isGM()       { return myRole() === "gm"; }

// ── canvas pan override ───────────────────────────────────────────────────────

let _originalAnimatePan = null;
let _panSuppressed = false;

function installPanGuard() {
  if (_originalAnimatePan) return;
  _originalAnimatePan = canvas.animatePan.bind(canvas);

  canvas.animatePan = function (view) {
    if (_panSuppressed) return Promise.resolve();
    return _originalAnimatePan(view);
  };
}

// ── token tracking ────────────────────────────────────────────────────────────

let _trackedTokenId = null;
let _trackingEnabled = true;

function onTokenMoved(token) {
  if (!isOperator()) return;
  if (!_trackingEnabled) return;

  const mode = setting("trackMode");

  if (mode === "players") {
    const actor = token.actor;
    if (!actor) return;
    const owners = Object.entries(actor.ownership ?? {})
      .filter(([uid, lvl]) => lvl >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)
      .map(([uid]) => uid);
    const isPlayerOwned = owners.some(uid => {
      const u = game.users.get(uid);
      return u && !u.isGM;
    });
    if (!isPlayerOwned) return;
  }

  if (mode === "combat") {
    const combatant = game.combat?.combatant;
    if (!combatant || combatant.tokenId !== token.id) return;
  }

  _trackedTokenId = token.id;
  panToToken(token);
}

function panToToken(token) {
  if (!token) return;
  const { x, y, width, height, parent } = token.document;
  const gridSize = parent?.grid?.size ?? 100;
  canvas.animatePan({
    x: x + (width  * gridSize) / 2,
    y: y + (height * gridSize) / 2,
    duration: 600,
  });
}

// ── GM ping → operator jump ───────────────────────────────────────────────────
//
// In Foundry v13 pings travel via the "userActivity" socket event:
//   ["userActivity", userId, { cursor: {x, y}, ping: { scene, pull, style, zoom } }]
//
// We intercept incoming packets on the operator client and react when
// the sender is a GM and the payload contains a "ping" field.

function installPingListener() {
  if (!isOperator()) return;

  const _onevent = game.socket.onevent.bind(game.socket);
  game.socket.onevent = function (packet) {
    _onevent(packet); // let Foundry handle it normally first

    const [event, userId, data] = packet.data ?? [];
    if (event !== "userActivity") return;
    if (!data?.ping) return;

    const sender = game.users.get(userId);
    if (!sender?.isGM) return;

    const x = data.cursor?.x;
    const y = data.cursor?.y;
    if (x == null || y == null) return;

    _trackingEnabled = false;
    _trackedTokenId = null;
    updateOperatorPanel();
    canvas.animatePan({ x, y, duration: 500 });
  };
}

// ── operator panel UI ─────────────────────────────────────────────────────────

function buildOperatorPanel() {
  if (!isOperator()) return;

  const existing = document.getElementById("stream-director-operator-panel");
  if (existing) existing.remove();

  const panel = document.createElement("div");
  panel.id = "stream-director-operator-panel";
  panel.innerHTML = `
    <div class="sdp-header">
      <span class="sdp-icon">🎥</span>
      <span>${game.i18n.localize("STREAMDIR.OperatorPanel.Title")}</span>
    </div>
    <div class="sdp-row">
      <span class="sdp-label">${game.i18n.localize("STREAMDIR.OperatorPanel.Tracking")}</span>
      <span class="sdp-value sdp-tracking-status"></span>
    </div>
    <div class="sdp-row">
      <span class="sdp-label">${game.i18n.localize("STREAMDIR.OperatorPanel.TrackedToken")}</span>
      <span class="sdp-value sdp-token-name">${game.i18n.localize("STREAMDIR.OperatorPanel.None")}</span>
    </div>
    <button class="sdp-btn sdp-toggle-btn">
      ${game.i18n.localize("STREAMDIR.OperatorPanel.ToggleTracking")}
    </button>
  `;
  document.body.appendChild(panel);

  panel.querySelector(".sdp-toggle-btn").addEventListener("click", () => {
    _trackingEnabled = !_trackingEnabled;
    updateOperatorPanel();
  });

  updateOperatorPanel();
}

function updateOperatorPanel() {
  const panel = document.getElementById("stream-director-operator-panel");
  if (!panel) return;

  const statusEl = panel.querySelector(".sdp-tracking-status");
  const tokenEl  = panel.querySelector(".sdp-token-name");

  if (_trackingEnabled) {
    statusEl.textContent = game.i18n.localize("STREAMDIR.OperatorPanel.TrackingOn");
    statusEl.className = "sdp-value sdp-tracking-on";
  } else {
    statusEl.textContent = game.i18n.localize("STREAMDIR.OperatorPanel.TrackingOff");
    statusEl.className = "sdp-value sdp-tracking-off";
  }

  const token = _trackedTokenId ? canvas.tokens?.get(_trackedTokenId) : null;
  tokenEl.textContent = token?.name ?? game.i18n.localize("STREAMDIR.OperatorPanel.None");
}

// ── Foundry hooks ─────────────────────────────────────────────────────────────

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "role", {
    name: "STREAMDIR.Settings.Role",
    hint: "STREAMDIR.Settings.RoleHint",
    scope: "client",
    config: true,
    type: String,
    choices: {
      gm:       "STREAMDIR.Settings.RoleGM",
      player:   "STREAMDIR.Settings.RolePlayer",
      operator: "STREAMDIR.Settings.RoleOperator",
    },
    default: "player",
  });

  game.settings.register(MODULE_ID, "operatorUserId", {
    name: "STREAMDIR.Settings.OperatorUserId",
    hint: "STREAMDIR.Settings.OperatorUserIdHint",
    scope: "world",
    config: true,
    type: String,
    default: "",
    requiresReload: false,
  });

  game.settings.register(MODULE_ID, "trackMode", {
    name: "STREAMDIR.Settings.TrackMode",
    hint: "STREAMDIR.Settings.TrackModeHint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      any:     "STREAMDIR.Settings.TrackModeAny",
      players: "STREAMDIR.Settings.TrackModePlayers",
      combat:  "STREAMDIR.Settings.TrackModeCombat",
    },
    default: "any",
  });
});

Hooks.once("ready", () => {
  // Install ping listener once — works across scene changes
  installPingListener();

  Hooks.on("canvasReady", () => {
    installPanGuard();

    const role = myRole();

    if (role === "gm" || role === "player") {
      _panSuppressed = true;
    } else {
      _panSuppressed = false;
    }

    if (role === "operator") {
      buildOperatorPanel();
    }

    const notifKey =
      role === "operator" ? "STREAMDIR.Notification.OperatorMode" :
      role === "gm"       ? "STREAMDIR.Notification.GMMode" :
                            "STREAMDIR.Notification.PlayerMode";
    ui.notifications.info(game.i18n.localize(notifKey));
  });
});

// ── token movement ────────────────────────────────────────────────────────────

Hooks.on("updateToken", (tokenDocument, changes, _options, _userId) => {
  if (!("x" in changes) && !("y" in changes)) return;
  if (!isOperator()) return;
  if (!_trackingEnabled) return;

  setTimeout(() => {
    const token = canvas.tokens?.get(tokenDocument.id);
    if (token) onTokenMoved(token);
  }, 50);
});

// ── combat turn change ────────────────────────────────────────────────────────

Hooks.on("combatTurnChange", (_combat, _prior, _current) => {
  if (!isOperator()) return;
  if (setting("trackMode") !== "combat") return;
  const combatant = game.combat?.combatant;
  if (!combatant) return;
  const token = canvas.tokens?.get(combatant.tokenId);
  if (token) {
    _trackedTokenId = token.id;
    panToToken(token);
    updateOperatorPanel();
  }
});
