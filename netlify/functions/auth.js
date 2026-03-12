// netlify/functions/auth.js
// Routes: POST /api/auth  with ?action=signup|login|logout|session
//
// Supabase handles OAuth (Twitch, Google) entirely client-side via
// supabase.auth.signInWithOAuth() — no server route needed for that.

const {
  supabase,
  supabaseAdmin,
  getUserFromToken,
  extractToken,
  respond,
  handleOptions,
} = require("../../lib/supabase");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return handleOptions();

  const action = event.queryStringParameters?.action;
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {}

  // ── GET /api/auth?action=session ────────────────────────────
  if (event.httpMethod === "GET" && action === "session") {
    const token = extractToken(event.headers.authorization);
    const user = await getUserFromToken(token);
    if (!user) return respond(401, { error: "Not authenticated" });
    return respond(200, { user });
  }

  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed" });
  }

  // ── POST /api/auth?action=signup ────────────────────────────
  if (action === "signup") {
    const { email, password, name } = body;
    if (!email || !password) {
      return respond(400, { error: "Email and password are required." });
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: name || "" } },
    });
    if (error) return respond(400, { error: error.message });

    // Create profile row (ignore conflict — user may already exist)
    await supabaseAdmin.from("profiles").upsert({
      id:         data.user.id,
      email:      data.user.email,
      full_name:  name || "",
      created_at: new Date().toISOString(),
    }, { onConflict: "id" });

    return respond(200, { user: data.user, session: data.session });
  }

  // ── POST /api/auth?action=login ─────────────────────────────
  if (action === "login") {
    const { email, password } = body;
    if (!email || !password) {
      return respond(400, { error: "Email and password are required." });
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return respond(401, { error: error.message });

    return respond(200, { user: data.user, session: data.session });
  }

  // ── POST /api/auth?action=logout ────────────────────────────
  if (action === "logout") {
    const token = extractToken(event.headers.authorization);
    if (!token) return respond(401, { error: "Not authenticated" });

    // Revoke the token server-side (best-effort)
    const authedClient = supabase;
    await authedClient.auth.admin?.signOut(token).catch(() => {});

    return respond(200, { message: "Logged out." });
  }

  // ── POST /api/auth?action=forgot-password ───────────────────
  if (action === "forgot-password") {
    const { email } = body;
    if (!email) return respond(400, { error: "Email is required." });

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${process.env.FRONTEND_URL}/reset-password`,
    });
    if (error) return respond(400, { error: error.message });

    return respond(200, { message: "Password reset email sent." });
  }

  return respond(400, { error: "Unknown action." });
};
