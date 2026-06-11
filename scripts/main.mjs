/**
 * Stream Director — main.mjs
 * Foundry VTT v13+
 *
 * Roles:
 *   "gm"       — GM window: free camera, never panned by others
 *   "player"   — Player window: own camera, never panned by others
 *   "operator" — Operator window: auto-follows moved tokens,
 *                jumps to points sent by the GM
 */

const MODULE_ID = "stream-director";
const SOCKET_NAME = `module.${MODULE_ID}`;

// ── helpers ──────────────────────────────────────────────────────────────────

function setting(key) {
  return game.settings.get(MODULE_ID, key);
}

/** Returns the role of THIS client. */
function myRole() {
  // If the GM has designated a specific user as operator via their user ID,
  // that takes priority over the local self-selected role.
  const operatorId = setting("operatorUserId")?.trim();
  if (operatorId && game.user.id === operatorId) return "operator";
  return setting("role");
}

function isOperator() { return myRole() === "operator"; }
function isGM()       { return myRole() === "gm"; }

// ── canvas pan override ───────────────────────────────────────────────────────
//
// Foundry v13 uses canvas.animatePan() for all programmatic pans
// (token movement pan, scene view, etc.).
// We wrap it so only the operator client actually executes remote pans.
//
// IMPORTANT: we only suppress pans that originate from Foundry's own
// "follow token" / "pan to user cursor" code, NOT explicit user drags.

let _originalAnimatePan = null;
let _panSuppressed = false;

function installPanGuard() {
  if (_originalAnimatePan) return; // already installed
  _originalAnimatePan = canvas.animatePan.bind(canvas);

  canvas.animatePan = function (view) {
    if (_panSuppressed) return Promise.resolve(); // block
    return _originalAnimatePan(view);
  };
}

/** Temporarily allow a single programmatic pan (used by operator). */
async function allowedPan(view) {
  _panSuppressed = false;
  await _originalAnimatePan(view);
}

// ── token tracking ────────────────────────────────────────────────────────────

let _trackedTokenId = null;
let _trackingEnabled = true;

/** Called when any token finishes moving. */
function onTokenMoved(token) {
  if (!isOperator()) return;
  if (!_trackingEnabled) return;

  const mode = setting("trackMode");

  if (mode === "players") {
    // Only track tokens owned by a non-GM player
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
    // Only track the currently active combatant
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

// ── GM jump ───────────────────────────────────────────────────────────────────

function sendJumpToOperator(worldX, worldY) {
  // Show local indicator
  showJumpIndicator(worldX, worldY);
  // Emit to all clients; only the operator will act
  game.socket.emit(SOCKET_NAME, {
    type: "jump",
    x: worldX,
    y: worldY,
    scale: canvas.stage.scale.x,
  });
}

function showJumpIndicator(worldX, worldY) {
  const el = document.getElementById("stream-director-jump-indicator");
  if (!el) return;
  // Convert world → screen
  const pt = canvas.stage.toGlobal({ x: worldX, y: worldY });
  el.style.left = `${pt.x}px`;
  el.style.top  = `${pt.y}px`;
  el.classList.remove("active");
  void el.offsetWidth; // reflow
  el.classList.add("active");
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

// ── jump indicator DOM element ────────────────────────────────────────────────

function buildJumpIndicator() {
  if (!isGM()) return;
  const el = document.createElement("div");
  el.id = "stream-director-jump-indicator";
  document.body.appendChild(el);
}

// ── mouse event for GM jump ───────────────────────────────────────────────────

function installGMMouseHandler() {
  if (!isGM()) return;

  const jumpButton = setting("jumpButton"); // "middle" | "right"

  if (jumpButton === "middle") {
    // auxclick fires for middle button (button === 1)
    canvas.app.view.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      const world = canvas.stage.toLocal({ x: e.clientX, y: e.clientY });
      sendJumpToOperator(world.x, world.y);
    });
  } else {
    // Right-click via canvas contextmenu hook
    // We add an entry to the canvas right-click context menu via a hook
    Hooks.on("getSceneControlButtons", () => {}); // ensure hooks are ready
    canvas.app.view.addEventListener("contextmenu", (e) => {
      // We'll handle this via the Foundry context-menu hook instead
    });
  }
}

// ── Foundry hooks ─────────────────────────────────────────────────────────────

Hooks.once("init", () => {
  // ── settings ──
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

  game.settings.register(MODULE_ID, "jumpButton", {
    name: "STREAMDIR.Settings.JumpButton",
    hint: "STREAMDIR.Settings.JumpButtonHint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      middle: "STREAMDIR.Settings.JumpButtonMiddle",
      right:  "STREAMDIR.Settings.JumpButtonRight",
    },
    default: "middle",
  });
});

Hooks.once("ready", () => {
  // ── pan guard: always install, suppress based on role ──
  Hooks.on("canvasReady", () => {
    installPanGuard();

    const role = myRole();

    // GM and players should have their pans suppressed when they come from
    // Foundry's auto-follow/pan system. We do this by always suppressing
    // remote pans unless we're the operator.
    if (role === "gm" || role === "player") {
      _panSuppressed = true;
      // Allow the user to still drag the canvas freely — that goes through
      // mouse events, not animatePan, so this is safe.
    } else {
      _panSuppressed = false;
    }

    if (role === "operator") {
      buildOperatorPanel();
    }

    if (role === "gm") {
      buildJumpIndicator();
      installGMMouseHandler();
    }

    // Notify the user of their active role
    const notifKey =
      role === "operator" ? "STREAMDIR.Notification.OperatorMode" :
      role === "gm"       ? "STREAMDIR.Notification.GMMode" :
                            "STREAMDIR.Notification.PlayerMode";
    ui.notifications.info(game.i18n.localize(notifKey));
  });

  // ── socket ──
  game.socket.on(SOCKET_NAME, (data) => {
    if (!isOperator()) return;

    if (data.type === "jump") {
      _trackingEnabled = false; // disable auto-tracking on manual jump
      _trackedTokenId = null;
      updateOperatorPanel();
      canvas.animatePan({ x: data.x, y: data.y, scale: data.scale, duration: 500 });
    }
  });
});

// ── token movement detection ──────────────────────────────────────────────────
//
// Foundry v13: Token#_onUpdate fires after the token document updates on the
// client. We hook into the token refresh pipeline instead via updateToken.

Hooks.on("updateToken", (tokenDocument, changes, _options, _userId) => {
  // Only react if position changed
  if (!("x" in changes) && !("y" in changes)) return;
  if (!isOperator()) return;
  if (!_trackingEnabled) return;

  // Wait one tick so the token sprite position is updated
  setTimeout(() => {
    const token = canvas.tokens?.get(tokenDocument.id);
    if (token) onTokenMoved(token);
  }, 50);
});

// Update panel when combat turn changes (for "combat" tracking mode)
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

// ── right-click context menu entry for GM jump ────────────────────────────────

Hooks.on("getSceneControlButtons", (controls) => {
  // We don't add a scene control; jump is via mouse button.
  // This hook is just here as a no-op to confirm controls are loaded.
});

/**
 * If jumpButton === "right", we intercept the canvas mousedown event
 * and check whether the user is holding a modifier key (Alt) +
 * right-click to avoid hijacking normal right-click behaviour.
 *
 * Re-installed on every canvasReady to handle scene changes.
 */
Hooks.on("canvasReady", () => {
  if (!isGM()) return;
  if (setting("jumpButton") !== "right") return;

  const view = canvas.app.view;
  if (view._sdStreamDirectorHandler) {
    view.removeEventListener("contextmenu", view._sdStreamDirectorHandler);
  }

  view._sdStreamDirectorHandler = (e) => {
    if (!e.altKey) return; // require Alt + right-click to send jump
    e.preventDefault();
    e.stopPropagation();
    const world = canvas.stage.toLocal({ x: e.clientX, y: e.clientY });
    sendJumpToOperator(world.x, world.y);
  };
  view.addEventListener("contextmenu", view._sdStreamDirectorHandler);
});

// Middle-click handler also reinstalled on canvasReady
Hooks.on("canvasReady", () => {
  if (!isGM()) return;
  if (setting("jumpButton") !== "middle") return;

  const view = canvas.app.view;
  if (view._sdStreamDirectorAuxHandler) {
    view.removeEventListener("auxclick", view._sdStreamDirectorAuxHandler);
  }

  view._sdStreamDirectorAuxHandler = (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    const world = canvas.stage.toLocal({ x: e.clientX, y: e.clientY });
    sendJumpToOperator(world.x, world.y);
  };
  view.addEventListener("auxclick", view._sdStreamDirectorAuxHandler);
});
