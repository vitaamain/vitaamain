// ─────────────────────────────────────────────────────────────
// vitaamain-supabase.js
// Drop this <script src="vitaamain-supabase.js"> into every HTML
// page BEFORE any page-specific scripts.
//
// Replace the two placeholder values below with your real keys
// from: Supabase Dashboard → Project Settings → API
// ─────────────────────────────────────────────────────────────

const SUPABASE_URL      = "https://cvlmhixdeatbicrwyplp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2bG1oaXhkZWF0Ymljcnd5cGxwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzNDQzMDAsImV4cCI6MjA4ODkyMDMwMH0.X3R6ZVAZXIzO1A98E0JomZGiiOUz0g-7MjQO9Kqdyy4";

// Load Supabase JS from CDN
(function () {
  const s = document.createElement("script");
  s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js";
  s.onload = () => {
    window._supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    document.dispatchEvent(new Event("supabase:ready"));
  };
  document.head.appendChild(s);
})();

// ─────────────────────────────────────────────────────────────
// AUTH HELPERS
// ─────────────────────────────────────────────────────────────

async function vmSignUp(email, password, name) {
  const { data, error } = await window._supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: name || "" } },
  });
  return { data, error };
}

async function vmLogin(email, password) {
  const { data, error } = await window._supabase.auth.signInWithPassword({
    email,
    password,
  });
  return { data, error };
}

async function vmLoginWithTwitch() {
  const { data, error } = await window._supabase.auth.signInWithOAuth({
    provider: "twitch",
    options: {
      redirectTo: window.location.origin + "/dashboard.html",
      scopes: "user:read:email channel:read:stream_key",
    },
  });
  return { data, error };
}

async function vmLoginWithGoogle() {
  const { data, error } = await window._supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: window.location.origin + "/dashboard.html",
      scopes: "https://www.googleapis.com/auth/youtube.readonly",
    },
  });
  return { data, error };
}

async function vmLogout() {
  const { error } = await window._supabase.auth.signOut();
  if (!error) window.location.href = "/login.html";
}

async function vmGetSession() {
  const { data: { session } } = await window._supabase.auth.getSession();
  return session;
}

async function vmGetUser() {
  const { data: { user } } = await window._supabase.auth.getUser();
  return user;
}

// Redirect to login if not authenticated
async function vmRequireAuth() {
  const session = await vmGetSession();
  if (!session) {
    window.location.href = "/login.html";
    return null;
  }
  return session;
}

// ─────────────────────────────────────────────────────────────
// API HELPERS  (calls your Netlify Functions via /api/*)
// ─────────────────────────────────────────────────────────────

async function vmApi(path, options = {}) {
  const session = await vmGetSession();
  const headers = {
    "Content-Type": "application/json",
    ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
    ...(options.headers || {}),
  };
  const res = await fetch(path, { ...options, headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// Platforms
async function vmGetPlatforms() {
  return vmApi("/api/platforms?action=list");
}
async function vmConnectPlatform(platform, streamKey, channelName, channelId) {
  return vmApi("/api/platforms?action=connect", {
    method: "POST",
    body: JSON.stringify({ platform, streamKey, channelName, channelId }),
  });
}
async function vmDisconnectPlatform(platform) {
  return vmApi(`/api/platforms?action=disconnect&platform=${platform}`, {
    method: "DELETE",
  });
}

// Stream sessions
async function vmStartStream(platforms, title, scene) {
  return vmApi("/api/stream?action=start", {
    method: "POST",
    body: JSON.stringify({ platforms, title, scene }),
  });
}
async function vmEndStream(sessionId, peakViewers, totalFollows, totalSubs) {
  return vmApi("/api/stream?action=end", {
    method: "POST",
    body: JSON.stringify({ sessionId, peakViewers, totalFollows, totalSubs }),
  });
}

// Alerts
async function vmGetAlerts(limit = 50) {
  return vmApi(`/api/alerts?action=list&limit=${limit}`);
}
async function vmFireTestAlert(kind, platform) {
  return vmApi("/api/alerts?action=test", {
    method: "POST",
    body: JSON.stringify({ kind, platform }),
  });
}

// ─────────────────────────────────────────────────────────────
// REALTIME ALERTS
// Subscribe to live alert inserts for the current user.
// Pass a callback that receives each new alert row.
//
// Usage:
//   const unsub = await vmSubscribeAlerts(alert => receiveAlert(alert));
//   // later: unsub() to stop listening
// ─────────────────────────────────────────────────────────────

async function vmSubscribeAlerts(onAlert) {
  const user = await vmGetUser();
  if (!user) return () => {};

  const channel = window._supabase
    .channel("stream-alerts-" + user.id)
    .on(
      "postgres_changes",
      {
        event:  "INSERT",
        schema: "public",
        table:  "stream_alerts",
        filter: `user_id=eq.${user.id}`,
      },
      (payload) => onAlert(payload.new)
    )
    .subscribe();

  return () => window._supabase.removeChannel(channel);
}
