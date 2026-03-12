// netlify/functions/alerts.js
// Stores and retrieves stream alerts (follows, subs, donations, raids).
// In production, Twitch/YouTube EventSub webhooks POST here and we
// fan-out to the client via Supabase Realtime (postgres_changes).
//
// Routes (via ?action=):
//   POST  ?action=webhook&platform=  — receive platform webhook event
//   GET   ?action=list               — get recent alerts for active session
//   POST  ?action=test               — fire a test alert (dev/preview)

const {
  supabaseAdmin,
  getUserFromToken,
  extractToken,
  respond,
  handleOptions,
} = require("../../lib/supabase");

// ── Alert type normaliser ────────────────────────────────────
// Each platform sends different event shapes. We normalise to a
// standard internal format before storing.

function normaliseTwitch(event) {
  const type = event.subscription?.type;
  const cond = event.event;
  if (!type || !cond) return null;

  const map = {
    "channel.follow":            { kind: "follow",   user: cond.user_name },
    "channel.subscribe":         { kind: "sub",       user: cond.user_name, tier: cond.tier },
    "channel.subscription.gift": { kind: "giftsub",  user: cond.user_name, count: cond.total },
    "channel.cheer":             { kind: "donation",  user: cond.user_name, amount: cond.bits, currency: "bits" },
    "channel.raid":              { kind: "raid",      user: cond.from_broadcaster_user_name, viewers: cond.viewers },
  };
  const norm = map[type];
  if (!norm) return null;
  return { platform: "twitch", ...norm, raw: event };
}

function normaliseYouTube(event) {
  const kind = event.kind;
  if (kind === "youtube#liveChatMessageInserted") {
    const details = event.snippet?.superChatDetails;
    if (details) {
      return {
        platform: "youtube",
        kind: "donation",
        user: event.authorDetails?.displayName,
        amount: details.amountDisplayString,
        currency: event.snippet?.currency,
        raw: event,
      };
    }
    if (event.snippet?.type === "newSponsorEvent") {
      return { platform: "youtube", kind: "sub", user: event.authorDetails?.displayName, raw: event };
    }
  }
  return null;
}

// ── Verify Twitch EventSub signature ────────────────────────
function verifyTwitchSignature(headers, rawBody) {
  // Full HMAC-SHA256 verification
  const crypto = require("crypto");
  const secret     = process.env.TWITCH_WEBHOOK_SECRET;
  const msgId      = headers["twitch-eventsub-message-id"]        || "";
  const timestamp  = headers["twitch-eventsub-message-timestamp"] || "";
  const signature  = headers["twitch-eventsub-message-signature"] || "";
  const hmac = "sha256=" + crypto
    .createHmac("sha256", secret)
    .update(msgId + timestamp + rawBody)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature));
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();

  const action   = event.queryStringParameters?.action;
  const platform = event.queryStringParameters?.platform;

  // ── POST ?action=webhook — no user auth, platform auth instead ─
  if (event.httpMethod === "POST" && action === "webhook") {
    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {}

    // ── Twitch EventSub challenge handshake ─────────────────────
    if (platform === "twitch") {
      const msgType = event.headers["twitch-eventsub-message-type"];

      if (msgType === "webhook_callback_verification") {
        // Respond with challenge to confirm subscription
        return {
          statusCode: 200,
          headers: { "Content-Type": "text/plain" },
          body: body.challenge,
        };
      }

      // Verify signature for all other messages
      try {
        const valid = verifyTwitchSignature(event.headers, event.body);
        if (!valid) return respond(403, { error: "Invalid signature" });
      } catch {
        return respond(403, { error: "Signature verification failed" });
      }

      const alert = normaliseTwitch(body);
      if (!alert) return respond(200, { message: "Event type not tracked." });

      // Look up which user owns this broadcaster channel
      const broadcasterId = body.event?.broadcaster_user_id;
      const { data: conn } = await supabaseAdmin
        .from("platform_connections")
        .select("user_id")
        .eq("platform", "twitch")
        .eq("channel_id", broadcasterId)
        .maybeSingle();

      if (!conn) return respond(200, { message: "No matching user." });

      await storeAlert(conn.user_id, alert);
      return respond(200, { message: "Alert stored." });
    }

    // ── YouTube push notification ───────────────────────────────
    if (platform === "youtube") {
      const alert = normaliseYouTube(body);
      if (!alert) return respond(200, { message: "Event type not tracked." });

      const channelId = body.snippet?.liveChatId;
      const { data: conn } = await supabaseAdmin
        .from("platform_connections")
        .select("user_id")
        .eq("platform", "youtube")
        .eq("channel_id", channelId)
        .maybeSingle();

      if (!conn) return respond(200, { message: "No matching user." });
      await storeAlert(conn.user_id, alert);
      return respond(200, { message: "Alert stored." });
    }

    return respond(400, { error: "Unsupported platform webhook." });
  }

  // All remaining routes require user auth
  const token = extractToken(event.headers.authorization);
  const user  = await getUserFromToken(token);
  if (!user) return respond(401, { error: "Not authenticated" });

  // ── GET ?action=list ─────────────────────────────────────────
  if (event.httpMethod === "GET" && action === "list") {
    const limit = parseInt(event.queryStringParameters?.limit || "50");

    const { data, error } = await supabaseAdmin
      .from("stream_alerts")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) return respond(500, { error: error.message });
    return respond(200, { alerts: data });
  }

  // ── POST ?action=test — fire a test alert ────────────────────
  if (event.httpMethod === "POST" && action === "test") {
    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {}

    const kinds = ["follow","sub","donation","raid","giftsub"];
    const kind  = body.kind || kinds[Math.floor(Math.random() * kinds.length)];

    const testAlert = {
      platform: body.platform || "twitch",
      kind,
      user: body.user || "TestUser",
      ...(kind === "donation"  ? { amount: "5.00", currency: "USD" } : {}),
      ...(kind === "raid"      ? { viewers: 42 } : {}),
      ...(kind === "giftsub"   ? { count: 5 } : {}),
      test: true,
    };

    await storeAlert(user.id, testAlert);
    return respond(200, { message: "Test alert fired.", alert: testAlert });
  }

  return respond(400, { error: "Unknown action." });
};

// ── Helper: insert alert row ─────────────────────────────────
async function storeAlert(userId, alert) {
  const { error } = await supabaseAdmin.from("stream_alerts").insert({
    user_id:   userId,
    platform:  alert.platform,
    kind:      alert.kind,
    user_name: alert.user || "Anonymous",
    amount:    alert.amount   || null,
    currency:  alert.currency || null,
    viewers:   alert.viewers  || null,
    gift_count:alert.count    || null,
    is_test:   alert.test     || false,
    created_at: new Date().toISOString(),
  });
  if (error) console.error("[alerts] insert error:", error.message);
}
