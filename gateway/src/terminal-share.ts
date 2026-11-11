// A27: shared terminal sessions between the apps of one workspace.
//
// The host app opens a share, then connects as host; teammates' apps list the
// workspace's shares and connect as guests. The gateway only relays frames:
// terminal output and input inside them are end-to-end encrypted by the apps
// with the team key (A22), so the server sees who joined, never what was
// typed or shown. The host decides whether guests may type.
import crypto from "node:crypto";
import type { WebSocket } from "ws";

export type ShareInfo = { id: string; title: string; hostEmail: string; guests: number; createdAt: string };

type Guest = { id: string; email: string; ws: WebSocket };
type Share = {
  id: string;
  organizationId: string;
  hostCenterId: string;
  hostEmail: string;
  title: string;
  createdAt: Date;
  host: WebSocket | null;
  guests: Map<string, Guest>;
  expires: NodeJS.Timeout | null;
};

const shares = new Map<string, Share>();
/** A share nobody hosts for this long is closed. */
const HOST_GRACE_MS = 60_000;
const MAX_SHARES_PER_ORG = 50;
const MAX_GUESTS = 10;
const MAX_FRAME = 256 * 1024;

function expireLater(share: Share) {
  if (share.expires) clearTimeout(share.expires);
  share.expires = setTimeout(() => close(share.id), HOST_GRACE_MS);
  share.expires.unref?.();
}

function close(id: string) {
  const share = shares.get(id);
  if (!share) return;
  shares.delete(id);
  if (share.expires) clearTimeout(share.expires);
  for (const g of share.guests.values()) g.ws.close(4000, "share ended");
  share.host?.close(4000, "share ended");
}

export function createShare(organizationId: string, hostCenterId: string, hostEmail: string, title: string) {
  const count = [...shares.values()].filter(s => s.organizationId === organizationId).length;
  if (count >= MAX_SHARES_PER_ORG) return null;
  const share: Share = {
    id: crypto.randomUUID(), organizationId, hostCenterId, hostEmail,
    title: title.slice(0, 120), createdAt: new Date(), host: null, guests: new Map(), expires: null,
  };
  shares.set(share.id, share);
  expireLater(share);
  return share.id;
}

export function listShares(organizationId: string): ShareInfo[] {
  return [...shares.values()]
    .filter(s => s.organizationId === organizationId && s.host)
    .map(s => ({ id: s.id, title: s.title, hostEmail: s.hostEmail, guests: s.guests.size, createdAt: s.createdAt.toISOString() }));
}

export function endShare(organizationId: string, centerId: string, id: string) {
  const share = shares.get(id);
  if (!share || share.organizationId !== organizationId || share.hostCenterId !== centerId) return false;
  close(id);
  return true;
}

function send(ws: WebSocket | null, frame: object) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

/**
 * Attaches a socket. Host frames: {t:"data", d, to?} (to one guest, or all),
 * {t:"kick", to}. Guest frames: {t:"input", d}. The relay adds who a guest
 * frame came from and tells the host when guests come and go.
 */
export function attach(
  ws: WebSocket,
  id: string,
  role: "host" | "guest",
  who: { organizationId: string; centerId: string; email: string },
) {
  const share = shares.get(id);
  if (!share || share.organizationId !== who.organizationId) {
    ws.close(4004, "no such share");
    return;
  }
  if (role === "host") {
    if (share.hostCenterId !== who.centerId) {
      ws.close(4003, "not the host");
      return;
    }
    share.host?.close(4001, "replaced");
    share.host = ws;
    if (share.expires) clearTimeout(share.expires);
    for (const g of share.guests.values()) send(ws, { t: "join", from: g.id, email: g.email });
    ws.on("message", (raw, isBinary) => {
      if (isBinary || (raw as Buffer).length > MAX_FRAME) return;
      let frame: { t?: string; d?: unknown; to?: unknown };
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      if (frame.t === "data" && typeof frame.d === "string") {
        const out = { t: "data", d: frame.d };
        if (typeof frame.to === "string") send(share.guests.get(frame.to)?.ws ?? null, out);
        else for (const g of share.guests.values()) send(g.ws, out);
      } else if (frame.t === "kick" && typeof frame.to === "string") {
        share.guests.get(frame.to)?.ws.close(4002, "removed by host");
      }
    });
    ws.on("close", () => {
      if (share.host !== ws) return;
      share.host = null;
      for (const g of share.guests.values()) send(g.ws, { t: "paused" });
      expireLater(share);
    });
    return;
  }
  if (share.guests.size >= MAX_GUESTS) {
    ws.close(4005, "share is full");
    return;
  }
  const guest: Guest = { id: crypto.randomUUID(), email: who.email, ws };
  share.guests.set(guest.id, guest);
  send(share.host, { t: "join", from: guest.id, email: guest.email });
  ws.on("message", (raw, isBinary) => {
    if (isBinary || (raw as Buffer).length > MAX_FRAME) return;
    let frame: { t?: string; d?: unknown };
    try { frame = JSON.parse(raw.toString()); } catch { return; }
    if (frame.t === "input" && typeof frame.d === "string") send(share.host, { t: "input", from: guest.id, d: frame.d });
  });
  ws.on("close", () => {
    share.guests.delete(guest.id);
    send(share.host, { t: "leave", from: guest.id, email: guest.email });
  });
}

/** Tests only. */
export function resetShares() {
  for (const id of [...shares.keys()]) close(id);
}
