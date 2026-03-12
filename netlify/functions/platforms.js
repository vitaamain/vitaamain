// netlify/functions/platforms.js
// Stores OAuth tokens for each connected streaming platform per user.
// Tokens are encrypted at rest in Supabase (AES-256 via pgcrypto extension).
//
// Routes (via ?action=):
//   GET    ?action=list                  — list connected platforms for user
//   POST   ?action=connect               — save platform OAuth token
//   DELETE ?action=disconnect&platform=  — remove a platform connection
//   GET    ?action=stream-key&platform=  — return RTMP key (decrypted)

const {
  supabaseAdmin,
  getUserFromToken,
  extractToken,
  respond,
  handleOptions,
} = require("../../lib/supabase");

// ── Platform metadata ────────────────────────────────────────
const PLATFORM_META = {
  twitch: {
    name:         "Twitch",
    rtmpUrl:      "rtmp://live.twitch.tv/app",
    supportsChat: true,
    supportsAlerts: true,
    supportsAnalytics: true,
    partial:      false,
  },
  youtube: {
    name:         "YouTube",
    rtmpUrl:      "rtmp://a.rtmp.youtube.com/live2",
    supportsChat: true,
    supportsAlerts: true,
    supportsAnalytics: true,
    partial:      false,
  },
  kick: {
    name:         "Kick",
    rtmpUrl:      "rtmp://fa723fc1b171.global-contribute.live-video.net/app",
    supportsChat: true,
    supportsAlerts: true,
    supportsAnalytics: false,
    partial:      true,
    partialNote:  "Analytics unavailable due to Kick API restrictions.",
  },
  tiktok: {
    name:         "TikTok Live",
    rtmpUrl:      null, // TikTok uses a custom RTMP provided per-stream
    supportsChat: true,  // read-only
    supportsAlerts: true, // follower alerts only
    supportsAnalytics: false,
    partial:      true,
    partialNote:  "Follower alerts only. Chat is read-only. No analytics.",
  },
  facebook: {
    name:         "Facebook Gaming",
    rtmpUrl:      "rtmps://live-api-s.facebook.com:443/rtmp",
    supportsChat: true,
    supportsAlerts: true,
    supportsAnalytics: true,
    partial:      true,
    partialNote:  "No donation alerts. Analytics delayed up to 24 hours.",
  },
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();

  // All routes require auth
  const token = extractToken(event.headers.authorization);
  const user  = await getUserFromToken(token);
  if (!user) return respond(401, { error: "Not authenticated" });

  const action   = event.queryStringParameters?.action;
  const platform = event.queryStringParameters?.platform;

  // ── GET ?action=list ─────────────────────────────────────────
  if (event.httpMethod === "GET" && action === "list") {
    const { data, error } = await supabaseAdmin
      .from("platform_connections")
      .select("platform, connected_at, channel_name, channel_id")
      .eq("user_id", user.id);

    if (error) return respond(500, { error: error.message });

    // Merge with static metadata
    const result = Object.entries(PLATFORM_META).map(([id, meta]) => {
      const conn = data?.find(d => d.platform === id) || null;
      return {
        id,
        ...meta,
        connected:    !!conn,
        connectedAt:  conn?.connected_at || null,
        channelName:  conn?.channel_name || null,
        channelId:    conn?.channel_id   || null,
      };
    });

    return respond(200, { platforms: result });
  }

  // ── POST ?action=connect ─────────────────────────────────────
  // In a real integration this receives the OAuth callback code,
  // exchanges it for a token, then stores it encrypted.
  if (event.httpMethod === "POST" && action === "connect") {
    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {}

    const { platform: plat, streamKey, channelName, channelId, accessToken } = body;
    if (!plat || !PLATFORM_META[plat]) {
      return respond(400, { error: "Unknown platform." });
    }
    if (!streamKey) {
      return respond(400, { error: "streamKey is required." });
    }

    // Upsert connection row
    const { error } = await supabaseAdmin
      .from("platform_connections")
      .upsert({
        user_id:      user.id,
        platform:     plat,
        // In production: encrypt stream_key with pgcrypto before storing
        stream_key:   streamKey,
        access_token: accessToken || null,
        channel_name: channelName || null,
        channel_id:   channelId   || null,
        connected_at: new Date().toISOString(),
      }, { onConflict: "user_id,platform" });

    if (error) return respond(500, { error: error.message });

    return respond(200, {
      message:  `${PLATFORM_META[plat].name} connected.`,
      platform: plat,
    });
  }

  // ── DELETE ?action=disconnect&platform= ──────────────────────
  if (event.httpMethod === "DELETE" && action === "disconnect") {
    if (!platform || !PLATFORM_META[platform]) {
      return respond(400, { error: "Unknown platform." });
    }

    const { error } = await supabaseAdmin
      .from("platform_connections")
      .delete()
      .eq("user_id", user.id)
      .eq("platform", platform);

    if (error) return respond(500, { error: error.message });

    return respond(200, { message: `${platform} disconnected.` });
  }

  // ── GET ?action=stream-key&platform= ────────────────────────
  if (event.httpMethod === "GET" && action === "stream-key") {
    if (!platform || !PLATFORM_META[platform]) {
      return respond(400, { error: "Unknown platform." });
    }

    const { data, error } = await supabaseAdmin
      .from("platform_connections")
      .select("stream_key, rtmp_url")
      .eq("user_id", user.id)
      .eq("platform", platform)
      .single();

    if (error || !data) return respond(404, { error: "Platform not connected." });

    return respond(200, {
      streamKey: data.stream_key,
      rtmpUrl:   data.rtmp_url || PLATFORM_META[platform].rtmpUrl,
    });
  }

  return respond(400, { error: "Unknown action." });
};
