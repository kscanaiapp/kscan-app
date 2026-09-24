import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 65_536;
const PAIR_TTL_MS = 120_000;
const SESSION_TTL_MS = 15 * 60_000;
const MAX_PAIR_ATTEMPTS_PER_WINDOW = 10;
const SERVER_DEVICE_ID = "00000000-0000-4000-8000-000000000001";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

type Json = Record<string, unknown>;

function response(body: Json, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function safeError(code: string, status = 400) {
  return response({ ok: false, code }, status);
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function randomCode(): string {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return value.toString().padStart(6, "0");
}

function parseFrame(raw: unknown): Json {
  if (typeof raw !== "string" || encoder.encode(raw).byteLength > MAX_FRAME_BYTES) throw new Error("PAYLOAD_TOO_LARGE");
  const frame = JSON.parse(raw) as Json;
  if (!frame || Array.isArray(frame) || typeof frame !== "object") throw new Error("INVALID_MESSAGE");
  if (containsForbiddenContent(frame)) throw new Error("FORBIDDEN_CONTENT");
  if (frame.protocolVersion !== PROTOCOL_VERSION || typeof frame.messageType !== "string") throw new Error("UNSUPPORTED_PROTOCOL");
  if (typeof frame.requestId !== "string" || !UUID_RE.test(frame.requestId)) throw new Error("INVALID_REQUEST_ID");
  if (typeof frame.deviceId !== "string" || !UUID_RE.test(frame.deviceId)) throw new Error("INVALID_DEVICE_ID");
  if (typeof frame.sessionId !== "string") throw new Error("INVALID_SESSION");
  const timestamp = Number(frame.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 30_000) throw new Error("STALE_MESSAGE");
  const expiresAt = frame.expiresAt == null ? null : Number(frame.expiresAt);
  if (expiresAt != null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) throw new Error("STALE_MESSAGE");
  return frame;
}

function containsForbiddenContent(value: unknown, key = ""): boolean {
  const normalized = key.toLowerCase();
  if (["image", "imagebase64", "base64", "accesstoken", "refreshtoken", "authorization"].includes(normalized)) return true;
  if (typeof value === "string") return value.startsWith("data:image") || value.length > MAX_FRAME_BYTES;
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenContent(entry));
  if (value && typeof value === "object") {
    return Object.entries(value as Json).some(([childKey, child]) => containsForbiddenContent(child, childKey.replaceAll("_", "")));
  }
  return false;
}

function wire(messageType: string, requestId: string, sessionId: string, deviceId: string, payload: Json, expiresAt?: number): string {
  return JSON.stringify({ protocolVersion: 1, messageType, requestId, sessionId, deviceId, timestamp: Date.now(), expiresAt: expiresAt ?? null, payload });
}

async function requireUser(req: Request, admin: any): Promise<string> {
  const authorization = req.headers.get("authorization") ?? "";
  const jwt = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!jwt) throw new Error("AUTH_REQUIRED");
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data?.user?.id) throw new Error("AUTH_REQUIRED");
  return data.user.id as string;
}

async function throttlePairAttempt(admin: any, userId: string, operation: string) {
  const since = new Date(Date.now() - PAIR_TTL_MS).toISOString();
  const { count, error } = await admin.from("wearable_auth_attempts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId).eq("operation", operation).gt("attempted_at", since);
  if (error) throw new Error("SAFE_BACKEND_FAILURE");
  if ((count ?? 0) >= MAX_PAIR_ATTEMPTS_PER_WINDOW) throw new Error("PAIR_RATE_LIMITED");
  await admin.from("wearable_auth_attempts").insert({ user_id: userId, operation });
}

async function sessionForToken(admin: any, token: unknown) {
  if (typeof token !== "string" || token.length < 32 || token.length > 128) throw new Error("SESSION_INVALID");
  const tokenHash = await sha256(token);
  const { data, error } = await admin.from("wearable_sessions").select("*").eq("token_hash", tokenHash).maybeSingle();
  if (error || !data) throw new Error("SESSION_INVALID");
  return data;
}

async function activeSessionForToken(admin: any, token: unknown) {
  const session = await sessionForToken(admin, token);
  if (session.revoked_at) throw new Error("SESSION_REVOKED");
  if (Date.parse(session.expires_at) <= Date.now()) {
    await admin.from("wearable_sessions").update({ revoked_at: new Date().toISOString(), revoke_reason: "expired" }).eq("id", session.id).is("revoked_at", null);
    throw new Error("SESSION_EXPIRED");
  }
  await admin.from("wearable_sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", session.id);
  return session;
}

async function insertMessage(admin: any, sessionId: string, direction: string, frame: Json) {
  const { error } = await admin.from("wearable_messages").upsert({
    session_id: sessionId,
    direction,
    request_id: frame.requestId,
    message_type: frame.messageType,
    frame,
    expires_at: new Date(Math.min(Number(frame.expiresAt ?? Date.now() + 60_000), Date.now() + 5 * 60_000)).toISOString(),
  }, { onConflict: "session_id,direction,request_id,message_type", ignoreDuplicates: true });
  if (error) throw new Error("MESSAGE_WRITE_FAILED");
}

export default {
  fetch: withSupabase({ auth: ["publishable", "secret"] }, async (req: Request, ctx: any) => {
    if (req.method !== "POST") return safeError("METHOD_NOT_ALLOWED", 405);
    let body: Json;
    try {
      const length = Number(req.headers.get("content-length") ?? 0);
      if (length > MAX_FRAME_BYTES + 8_192) return safeError("PAYLOAD_TOO_LARGE", 413);
      body = await req.json();
    } catch {
      return safeError("INVALID_JSON");
    }
    const admin = ctx.supabaseAdmin;

    try {
      switch (body.operation) {
        case "pair.create": {
          const frame = parseFrame(body.frame);
          if (frame.messageType !== "pair.request" || frame.sessionId !== "") throw new Error("INVALID_MESSAGE");
          const payload = frame.payload as Json;
          const code = randomCode();
          const pairingSecret = randomToken();
          const expiresAt = new Date(Date.now() + PAIR_TTL_MS).toISOString();
          await admin.from("wearable_pairings").update({ status: "expired" }).eq("device_id", frame.deviceId).eq("status", "pending");
          const { data, error } = await admin.from("wearable_pairings").insert({
            challenge_hash: await sha256(code), pairing_secret_hash: await sha256(pairingSecret),
            request_id: frame.requestId, device_id: frame.deviceId,
            device_model: String(payload?.model ?? "").slice(0, 80),
            device_app_version: String(payload?.appVersion ?? "").slice(0, 40),
            protocol_version: 1, expires_at: expiresAt,
          }).select("pairing_handle").single();
          if (error || !data) throw new Error("PAIR_CREATE_FAILED");
          return response({ ticket: { pairingHandle: data.pairing_handle, challengeCode: code, pairingSecret, expiresAt: Date.parse(expiresAt) } });
        }
        case "pair.approve": {
          const userId = await requireUser(req, admin);
          await throttlePairAttempt(admin, userId, "pair.approve");
          if (typeof body.challengeCode !== "string" || !/^\d{6}$/.test(body.challengeCode)) throw new Error("INVALID_CHALLENGE");
          if (typeof body.phoneDeviceId !== "string" || !UUID_RE.test(body.phoneDeviceId)) throw new Error("INVALID_DEVICE_ID");
          const { data: pairing, error } = await admin.from("wearable_pairings").select("*")
            .eq("challenge_hash", await sha256(body.challengeCode)).eq("status", "pending")
            .gt("expires_at", new Date().toISOString()).maybeSingle();
          if (error || !pairing) throw new Error("PAIR_NOT_FOUND");
          const { error: updateError } = await admin.from("wearable_pairings").update({
            status: "approved", user_id: userId, phone_device_id: body.phoneDeviceId, approved_at: new Date().toISOString(),
          }).eq("id", pairing.id).eq("status", "pending");
          if (updateError) throw new Error("PAIR_APPROVE_FAILED");
          return response({ ok: true, pairingHandle: pairing.pairing_handle, deviceModel: pairing.device_model });
        }
        case "pair.deny": {
          const userId = await requireUser(req, admin);
          await throttlePairAttempt(admin, userId, "pair.deny");
          if (typeof body.challengeCode !== "string") throw new Error("INVALID_CHALLENGE");
          const { data: pairing } = await admin.from("wearable_pairings").select("id")
            .eq("challenge_hash", await sha256(body.challengeCode)).eq("status", "pending").maybeSingle();
          if (!pairing) throw new Error("PAIR_NOT_FOUND");
          await admin.from("wearable_pairings").update({ status: "denied", user_id: userId, approved_at: new Date().toISOString() }).eq("id", pairing.id).eq("status", "pending");
          return response({ ok: true });
        }
        case "pair.poll": {
          if (typeof body.pairingHandle !== "string" || typeof body.pairingSecret !== "string") throw new Error("PAIR_NOT_FOUND");
          const { data: pairing } = await admin.from("wearable_pairings").select("*").eq("pairing_handle", body.pairingHandle).maybeSingle();
          if (!pairing || pairing.pairing_secret_hash !== await sha256(body.pairingSecret)) throw new Error("PAIR_NOT_FOUND");
          if (pairing.status === "pending" && Date.parse(pairing.expires_at) <= Date.now()) {
            await admin.from("wearable_pairings").update({ status: "expired" }).eq("id", pairing.id).eq("status", "pending");
            return response({ poll: { cursor: 0, frames: [wire("pair.expired", pairing.request_id, "", SERVER_DEVICE_ID, {})] } });
          }
          if (pairing.status === "denied") return response({ poll: { cursor: 0, frames: [wire("pair.denied", pairing.request_id, "", SERVER_DEVICE_ID, { reason: "USER_REJECTED" })] } });
          if (pairing.status !== "approved") return response({ poll: { cursor: 0, frames: [] } });
          const token = randomToken();
          const sessionExpiresAt = Date.now() + SESSION_TTL_MS;
          await admin.from("wearable_sessions").update({ revoked_at: new Date().toISOString(), revoke_reason: "replaced" }).eq("device_id", pairing.device_id).is("revoked_at", null);
          const { data: session, error } = await admin.from("wearable_sessions").insert({
            pairing_id: pairing.id, user_id: pairing.user_id, device_id: pairing.device_id,
            protocol_version: 1, token_hash: await sha256(token), expires_at: new Date(sessionExpiresAt).toISOString(),
          }).select("id").single();
          if (error || !session) throw new Error("SESSION_CREATE_FAILED");
          await admin.from("wearable_pairings").update({ status: "consumed", consumed_at: new Date().toISOString() }).eq("id", pairing.id).eq("status", "approved");
          const frames = [
            wire("pair.approved", pairing.request_id, session.id, pairing.phone_device_id, { sessionExpiresAt }),
            wire("session.ready", crypto.randomUUID(), session.id, pairing.phone_device_id, { phoneAppVersion: String(body.phoneAppVersion ?? "K Scan"), features: ["phone_capture", "stylematch", "save", "open_on_phone"] }),
          ];
          return response({ poll: { cursor: 0, frames, wearableToken: token } });
        }
        case "session.send": {
          const session = await activeSessionForToken(admin, body.wearableToken);
          const frame = parseFrame(body.frame);
          if (frame.sessionId !== session.id || frame.deviceId !== session.device_id) throw new Error("WRONG_SESSION");
          await insertMessage(admin, session.id, "to_phone", frame);
          return response({ ok: true });
        }
        case "session.poll": {
          const session = await sessionForToken(admin, body.wearableToken);
          if (session.revoked_at || Date.parse(session.expires_at) <= Date.now()) {
            const { data: pairing } = await admin.from("wearable_pairings").select("phone_device_id").eq("id", session.pairing_id).single();
            const reason = session.revoke_reason === "expired" || Date.parse(session.expires_at) <= Date.now() ? "EXPIRED" :
              session.revoke_reason === "replaced" ? "REPLACED" : session.revoke_reason === "error" ? "ERROR" : "USER_REVOKED";
            return response({ poll: { cursor: Number(body.after ?? 0), frames: [wire("session.revoked", crypto.randomUUID(), session.id, pairing?.phone_device_id ?? SERVER_DEVICE_ID, { reason })] } });
          }
          await admin.from("wearable_sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", session.id);
          const after = Math.max(0, Number(body.after ?? 0));
          const { data, error } = await admin.from("wearable_messages").select("id,frame")
            .eq("session_id", session.id).eq("direction", "to_wearable").gt("id", after)
            .gt("expires_at", new Date().toISOString()).order("id").limit(50);
          if (error) throw new Error("POLL_FAILED");
          return response({ poll: { cursor: data?.at(-1)?.id ?? after, frames: (data ?? []).map((row: any) => JSON.stringify(row.frame)) } });
        }
        case "phone.sessions": {
          const userId = await requireUser(req, admin);
          const { data, error } = await admin.from("wearable_sessions").select("id,device_id,expires_at,last_seen_at,created_at,wearable_pairings!inner(device_model)")
            .eq("user_id", userId).is("revoked_at", null).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false });
          if (error) throw new Error("SESSIONS_FAILED");
          return response({ sessions: data ?? [] });
        }
        case "phone.poll": {
          const userId = await requireUser(req, admin);
          const sessionId = String(body.sessionId ?? "");
          const { data: session } = await admin.from("wearable_sessions").select("id,device_id,expires_at,revoked_at").eq("id", sessionId).eq("user_id", userId).maybeSingle();
          if (!session || session.revoked_at || Date.parse(session.expires_at) <= Date.now()) throw new Error("SESSION_INVALID");
          const after = Math.max(0, Number(body.after ?? 0));
          const { data, error } = await admin.from("wearable_messages").select("id,frame").eq("session_id", sessionId)
            .eq("direction", "to_phone").gt("id", after).gt("expires_at", new Date().toISOString()).order("id").limit(50);
          if (error) throw new Error("POLL_FAILED");
          return response({ poll: { cursor: data?.at(-1)?.id ?? after, frames: (data ?? []).map((row: any) => JSON.stringify(row.frame)) } });
        }
        case "phone.send": {
          const userId = await requireUser(req, admin);
          const sessionId = String(body.sessionId ?? "");
          const { data: session } = await admin.from("wearable_sessions").select("id,device_id,expires_at,revoked_at,wearable_pairings!inner(phone_device_id)")
            .eq("id", sessionId).eq("user_id", userId).maybeSingle();
          if (!session || session.revoked_at || Date.parse(session.expires_at) <= Date.now()) throw new Error("SESSION_INVALID");
          const frame = parseFrame(body.frame);
          if (frame.sessionId !== session.id || frame.deviceId !== session.wearable_pairings.phone_device_id) throw new Error("WRONG_SESSION");
          if (frame.messageType === "result.show" || frame.messageType === "result.update") {
            const result = ((frame.payload as Json)?.result ?? null) as Json | null;
            const resultId = String(result?.resultId ?? "");
            if (!UUID_RE.test(resultId)) throw new Error("INVALID_RESULT");
            const revision = frame.messageType === "result.update" ? Number((frame.payload as Json).revision ?? 1) : 1;
            if (!Number.isInteger(revision) || revision < 1 || revision > 1000) throw new Error("INVALID_RESULT");
            // Ownership + revision guard: a result id is only writable by the
            // user/session that created it; stale revisions are rejected so an
            // old frame can never overwrite a newer result.
            const { data: existingResult } = await admin.from("wearable_results").select("user_id,session_id,revision").eq("id", resultId).maybeSingle();
            if (existingResult && (existingResult.user_id !== userId || existingResult.session_id !== session.id)) throw new Error("INVALID_RESULT");
            if (existingResult && revision < Number(existingResult.revision)) throw new Error("STALE_REVISION");
            if (!existingResult) {
              const { error: resultError } = await admin.from("wearable_results").insert({
                id: resultId, session_id: session.id, user_id: userId, scan_id: resultId,
                revision, status: String(result?.scanStatus ?? "completed").toLowerCase(),
                payload: result, updated_at: new Date().toISOString(),
              });
              if (resultError) throw new Error("RESULT_WRITE_FAILED");
            } else if (revision > Number(existingResult.revision)) {
              const { error: resultError } = await admin.from("wearable_results").update({
                revision, status: String(result?.scanStatus ?? "completed").toLowerCase(),
                payload: result, updated_at: new Date().toISOString(),
              }).eq("id", resultId).eq("user_id", userId).eq("session_id", session.id).eq("revision", Number(existingResult.revision));
              if (resultError) throw new Error("RESULT_WRITE_FAILED");
            }
            // Equal revision: idempotent resend — frame is forwarded without a write.
          }
          await insertMessage(admin, session.id, "to_wearable", frame);
          return response({ ok: true });
        }
        case "phone.action": {
          const userId = await requireUser(req, admin);
          const sessionId = String(body.sessionId ?? "");
          const actionId = String(body.actionId ?? "");
          const resultId = String(body.resultId ?? "");
          const actionType = String(body.actionType ?? "");
          if (!UUID_RE.test(actionId) || !UUID_RE.test(resultId) || !["save", "open_on_phone"].includes(actionType)) throw new Error("INVALID_ACTION");
          // Session must be live: a revoked or expired session can no longer
          // persist actions even for its owning user.
          const { data: session } = await admin.from("wearable_sessions").select("id,revoked_at,expires_at")
            .eq("id", sessionId).eq("user_id", userId).maybeSingle();
          if (!session || session.revoked_at || Date.parse(session.expires_at) <= Date.now()) throw new Error("SESSION_INVALID");
          const { data: result } = await admin.from("wearable_results").select("id,payload,revision,user_id,session_id,saved_at")
            .eq("id", resultId).eq("user_id", userId).eq("session_id", sessionId).maybeSingle();
          if (!result) throw new Error("INVALID_RESULT");
          const { data: existing } = await admin.from("wearable_actions").select("status,result_id,action_type").eq("id", actionId).eq("session_id", sessionId).maybeSingle();
          // An action id is single-purpose: reuse with a different result or
          // action type is a conflict, never a silent re-execution.
          if (existing && (existing.result_id !== resultId || existing.action_type !== actionType)) throw new Error("ACTION_CONFLICT");
          if (!existing) {
            const { error } = await admin.from("wearable_actions").insert({
              id: actionId, session_id: sessionId, user_id: userId, result_id: resultId,
              action_type: actionType, status: "completed", completed_at: new Date().toISOString(),
            });
            if (error) {
              // Lost an idempotency race — another request inserted this action first.
              const { data: raced } = await admin.from("wearable_actions").select("status,result_id,action_type").eq("id", actionId).eq("session_id", sessionId).maybeSingle();
              if (!raced || raced.result_id !== resultId || raced.action_type !== actionType) throw new Error("ACTION_FAILED");
              return response({ result: result.payload, revision: Number(result.revision) + 1, duplicate: true });
            }
            if (actionType === "save") {
              // Real persistence: Save writes the bounded wearable result into the
              // canonical K Scan library (saved_scans), deduped per result id.
              const payload = (result.payload ?? {}) as Json;
              const { data: priorSave } = await admin.from("saved_scans").select("id")
                .eq("user_id", userId).eq("metadata->>wearableResultId", resultId).maybeSingle();
              if (!priorSave) {
                const { error: saveError } = await admin.from("saved_scans").insert({
                  user_id: userId,
                  title: String(payload.summary ?? "Wearable scan").slice(0, 120) || "Wearable scan",
                  scan_type: "camera",
                  analysis_result: payload,
                  products: Array.isArray(payload.products) ? payload.products : [],
                  source: "wearable",
                  metadata: { wearableResultId: resultId, wearableSessionId: sessionId, contractVersion: "wearable-result-v1" },
                });
                if (saveError) throw new Error("SAVE_FAILED");
              }
              if (!result.saved_at) {
                await admin.from("wearable_results").update({ saved_at: new Date().toISOString() }).eq("id", resultId).eq("user_id", userId);
              }
            }
          }
          return response({ result: result.payload, revision: Number(result.revision) + 1, duplicate: !!existing });
        }
        case "phone.revoke": {
          const userId = await requireUser(req, admin);
          const sessionId = String(body.sessionId ?? "");
          const { data: session } = await admin.from("wearable_sessions").select("id,device_id,wearable_pairings!inner(phone_device_id)").eq("id", sessionId).eq("user_id", userId).is("revoked_at", null).maybeSingle();
          if (!session) return response({ ok: true });
          await admin.from("wearable_sessions").update({ revoked_at: new Date().toISOString(), revoke_reason: body.reason === "sign_out" ? "sign_out" : "user_revoked" }).eq("id", session.id).eq("user_id", userId).is("revoked_at", null);
          return response({ ok: true });
        }
        case "phone.revoke_all": {
          const userId = await requireUser(req, admin);
          await admin.from("wearable_sessions").update({ revoked_at: new Date().toISOString(), revoke_reason: "sign_out" }).eq("user_id", userId).is("revoked_at", null);
          return response({ ok: true });
        }
        default:
          return safeError("UNSUPPORTED_OPERATION");
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : "SAFE_BACKEND_FAILURE";
      const status = code === "AUTH_REQUIRED" ? 401 : code === "PAIR_RATE_LIMITED" ? 429 : code.startsWith("SESSION_") ? 403 : 400;
      return safeError(/^[A-Z0-9_]{3,48}$/.test(code) ? code : "SAFE_BACKEND_FAILURE", status);
    }
  }),
};
