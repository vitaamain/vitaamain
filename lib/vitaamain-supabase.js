// lib/supabase.js — shared across all Netlify Functions
// Uses service-role key server-side (bypasses RLS for admin ops)
// Uses anon key when verifying user JWTs

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL      = process.env.SUPABASE_URL      || "https://cvlmhixdeatbicrwyplp.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2bG1oaXhkZWF0Ymljcnd5cGxwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzNDQzMDAsImV4cCI6MjA4ODkyMDMwMH0.X3R6ZVAZXIzO1A98E0JomZGiiOUz0g-7MjQO9Kqdyy4";
const SUPABASE_SVC_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2bG1oaXhkZWF0Ymljcnd5cGxwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzM0NDMwMCwiZXhwIjoyMDg4OTIwMzAwfQ.rpAAoi4pa5T5B_Ks800wpNPmezNiY5obZjZiGfbhP10";

// Public client — respects Row Level Security
// Use this when acting on behalf of a logged-in user (pass their JWT)
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

// Admin client — bypasses RLS
// ONLY use server-side, never expose to frontend
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SVC_KEY, {
  auth: { persistSession: false },
});

/**
 * Verify a Supabase JWT and return the user, or null if invalid.
 * @param {string} token  Bearer token from Authorization header
 */
async function getUserFromToken(token) {
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

/**
 * Extract Bearer token from an Authorization header string.
 * @param {string} header  e.g. "Bearer eyJhbGci..."
 */
function extractToken(header = "") {
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

/**
 * Standard CORS headers for all function responses.
 */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  process.env.FRONTEND_URL || "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Content-Type": "application/json",
};

/**
 * Return a JSON response object for Netlify Functions.
 */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}

/**
 * Handle OPTIONS preflight for CORS.
 */
function handleOptions() {
  return { statusCode: 204, headers: CORS_HEADERS, body: "" };
}

module.exports = {
  supabase,
  supabaseAdmin,
  getUserFromToken,
  extractToken,
  respond,
  handleOptions,
  CORS_HEADERS,
};
