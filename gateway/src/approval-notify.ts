// E-mail admins/owners when an AI client's HIGH-risk operation waits for
// approval. One mail per new approval request (identical pending requests are
// reused and do not mail again). The link opens the Approvals view; approving
// still requires the recipient's browser session, so the mail grants nothing.

import { db } from "./db.js";
import { enqueueMail, mailConfigured } from "./mail.js";
import type { AgentAction } from "./protocol.js";

const MAX_RECIPIENTS = 10;

function describe(action: AgentAction) {
  const a = action as Record<string, unknown>;
  const detail = typeof a.command === "string" ? a.command
    : typeof a.path === "string" ? a.path
    : typeof a.pid === "number" ? "pid " + a.pid
    : typeof a.taskId === "string" ? a.taskId
    : typeof a.sessionId === "string" ? a.sessionId
    : "";
  // Single line, bounded: never let operation text shape the mail.
  return detail.replace(/[\r\n\t]+/g, " ").slice(0, 300);
}

export async function notifyApprovers(
  organizationId: string,
  deviceId: string,
  action: AgentAction,
  requestId: string,
  expiresAt: Date,
) {
  if (!mailConfigured()) return 0;
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) return 0;
  const [recipients, device] = await Promise.all([
    db.query<{ email: string }>(
      `select u.email from organization_members m join users u on u.id=m.user_id
        where m.organization_id=$1 and m.role in ('admin','owner')
          and u.disabled_at is null and u.email_verified_at is not null
        order by m.role desc, u.email limit $2`,
      [organizationId, MAX_RECIPIENTS],
    ),
    db.query<{ name: string; hostname: string }>(
      "select name,hostname from devices where id=$1 and organization_id=$2", [deviceId, organizationId],
    ),
  ]);
  const deviceName = device.rows[0]?.name || deviceId;
  const link = `${base}/advanced?view=approvals`;
  const detail = describe(action);
  const expires = new Date(expiresAt).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  for (const { email } of recipients.rows) {
    await enqueueMail({
      to: email,
      subject: `WECOMMANDER: onay bekleyen işlem (${action.kind}) · ${deviceName}`.slice(0, 160),
      text:
        `Bir yapay zekâ istemcisi yüksek riskli bir işlem istiyor ve onayınızı bekliyor.\n\n` +
        `Cihaz: ${deviceName}\nİşlem: ${action.kind}\n${detail ? `Ayrıntı: ${detail}\n` : ""}` +
        `Son geçerlilik: ${expires}\nTalep: ${requestId}\n\n` +
        `İncelemek ve onaylamak ya da reddetmek için:\n${link}\n\n` +
        `Onay yalnızca oturum açtığınız tarayıcıdan verilebilir. Bu işlemi siz başlatmadıysanız reddedin.\n\n` +
        `---\nAn AI client requested a HIGH-risk operation (${action.kind} on ${deviceName}). Review it at ${link}`,
    });
  }
  return recipients.rows.length;
}
