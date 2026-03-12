// netlify/functions/stream.js
// Manages stream sessions — start, end, and fetch history.
// The actual RTMP encoding happens client-side (browser MediaRecorder
// + WebRTC → each platform's RTMP endpoint via their stream key).
// This function records session metadata in Supabase.
//
// Routes (via ?action=):
//   POST  ?action=start   — create a new stream session
//   POST  ?action=end     — mark session as ended, save duration
//   GET   ?action=status  — get current active session
//   GET   ?action=history — get past stream sessions

const {
  supabaseAdmin,
  getUserFromToken,
  extractToken,
  respond,
  handleOptions,
} = require("../../lib/supabase");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();

  const token = extractToken(event.headers.authorization);
  const user  = await getUserFromToken(token);
  if (!user) return respond(401, { error: "Not authenticated" });

  const action = event.queryStringParameters?.action;
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  // ── POST ?action=start ───────────────────────────────────────
  if (event.httpMethod === "POST" && action === "start") {
    const { platforms, title, scene } = body;

    if (!platforms || !Array.isArray(platforms) || platforms.length === 0) {
      return respond(400, { error: "At least one platform is required." });
    }

    // End any orphaned active sessions first
    await supabaseAdmin
      .from("stream_sessions")
      .update({ status: "ended", ended_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .eq("status", "active");

    // Create new session
    const { data, error } = await supabaseAdmin
      .from("stream_sessions")
      .insert({
        user_id:    user.id,
        platforms:  platforms,   // array of platform ids
        title:      title || "Live Stream",
        scene:      scene || "Default",
        status:     "active",
        started_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) return respond(500, { error: error.message });

    return respond(200, { session: data });
  }

  // ── POST ?action=end ─────────────────────────────────────────
  if (event.httpMethod === "POST" && action === "end") {
    const { sessionId, peakViewers, totalFollows, totalSubs } = body;

    const query = supabaseAdmin
      .from("stream_sessions")
      .update({
        status:        "ended",
        ended_at:      new Date().toISOString(),
        peak_viewers:  peakViewers  || 0,
        total_follows: totalFollows || 0,
        total_subs:    totalSubs    || 0,
      })
      .eq("user_id", user.id)
      .eq("status", "active");

    if (sessionId) query.eq("id", sessionId);

    const { data, error } = await query.select().single();
    if (error) return respond(500, { error: error.message });

    return respond(200, { session: data });
  }

  // ── GET ?action=status ───────────────────────────────────────
  if (event.httpMethod === "GET" && action === "status") {
    const { data, error } = await supabaseAdmin
      .from("stream_sessions")
      .select("*")
      .eq("user_id", user.id)
      .eq("status", "active")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) return respond(500, { error: error.message });

    return respond(200, { session: data || null });
  }

  // ── GET ?action=history ──────────────────────────────────────
  if (event.httpMethod === "GET" && action === "history") {
    const limit  = parseInt(event.queryStringParameters?.limit  || "20");
    const offset = parseInt(event.queryStringParameters?.offset || "0");

    const { data, error, count } = await supabaseAdmin
      .from("stream_sessions")
      .select("*", { count: "exact" })
      .eq("user_id", user.id)
      .eq("status", "ended")
      .order("started_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) return respond(500, { error: error.message });

    return respond(200, { sessions: data, total: count });
  }

  return respond(400, { error: "Unknown action." });
};
