import crypto from "node:crypto";
import { z } from "zod";
import { db } from "./db.js";
import { enqueueMail, mailLinkDigest } from "./mail.js";

// Marketing: email campaigns. Only people who said yes (a box on the sign-up
// form, or the switch on the account page) receive them; every mail carries
// an unsubscribe link and a one-click List-Unsubscribe header, and nobody
// gets the same campaign twice.

export const emailAudienceSchema = z.object({
  plans: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  minDays: z.number().int().min(0).max(3650).nullable().default(null),
  maxDays: z.number().int().min(0).max(3650).nullable().default(null),
});
export type EmailAudience = z.infer<typeof emailAudienceSchema>;

export const emailSchema = z.object({
  id: z.string().uuid().optional(),
  subject: z.string().trim().min(1).max(150),
  body: z.string().trim().min(1).max(20000),
  audience: emailAudienceSchema.default({ plans: [], minDays: null, maxDays: null }),
});

/** Most recipients one send reaches; a larger list is sent again later for the rest. */
export const MAX_RECIPIENTS_PER_SEND = 5000;

/** The digest that proves an unsubscribe link was made for this user (null without a mail key). */
export function unsubscribeDigest(userId: string) {
  return mailLinkDigest("unsubscribe:" + userId);
}

export function validUnsubscribe(userId: string, digest: string) {
  const expected = unsubscribeDigest(userId);
  if (!expected || expected.length !== digest.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(digest));
}

export function unsubscribeLinks(baseUrl: string, userId: string) {
  const digest = unsubscribeDigest(userId);
  if (!digest) return null;
  const query = `u=${encodeURIComponent(userId)}&t=${encodeURIComponent(digest)}`;
  return { page: `${baseUrl}/unsubscribe?${query}`, oneClick: `${baseUrl}/api/unsubscribe?${query}` };
}

/** The campaign text with the unsubscribe footer every marketing mail ends with. */
export function mailText(body: string, unsubscribeUrl: string) {
  return (
    body.trim() +
    "\n\n—\n" +
    "Bu e-postayı WECOMMANDER ürün haberlerini almayı kabul ettiğin için aldın.\n" +
    "You receive this because you opted in to WECOMMANDER product news.\n" +
    "Abonelikten çık / Unsubscribe: " + unsubscribeUrl + "\n"
  );
}

/** SQL condition (on users `u`) for the people a campaign may reach, with its parameters starting at $`from`. */
export function audienceCondition(audience: EmailAudience, from: number) {
  const parts = [
    "u.marketing_opt_in",
    "u.email_verified_at is not null",
    "u.disabled_at is null",
  ];
  const params: unknown[] = [];
  if (audience.plans.length > 0) {
    params.push(audience.plans);
    parts.push(
      `exists(select 1 from organization_members m join organization_subscriptions s on s.organization_id=m.organization_id
               where m.user_id=u.id and s.status in ('trialing','active','past_due') and s.plan_key=any($${from + params.length}::text[]))`,
    );
  }
  if (audience.minDays !== null) {
    params.push(audience.minDays);
    parts.push(`u.created_at<=now()-($${from + params.length}::int*interval '1 day')`);
  }
  if (audience.maxDays !== null) {
    params.push(audience.maxDays);
    parts.push(`u.created_at>=now()-($${from + params.length}::int*interval '1 day')`);
  }
  return { sql: parts.join(" and "), params };
}

/** How many people would receive a campaign with this audience right now. */
export async function audienceSize(audience: EmailAudience, excludeEmailId?: string) {
  const condition = audienceCondition(audience, excludeEmailId ? 1 : 0);
  const params = excludeEmailId ? [excludeEmailId, ...condition.params] : condition.params;
  const exclude = excludeEmailId
    ? " and not exists(select 1 from marketing_email_recipients r where r.email_id=$1 and r.user_id=u.id)"
    : "";
  const result = await db.query<{ n: number }>(
    `select count(*)::int as n from users u where ${condition.sql}${exclude}`,
    params,
  );
  return result.rows[0]?.n ?? 0;
}

export async function listEmails() {
  const rows = await db.query(
    `select e.id,e.subject,e.body,e.audience,e.status,e.sent_at,e.created_at,e.updated_at,
            (select count(*)::int from marketing_email_recipients r where r.email_id=e.id) as recipients
       from marketing_emails e order by e.created_at desc limit 200`,
  );
  const subscribers = await db.query<{ n: number; total: number }>(
    `select count(*) filter (where marketing_opt_in and email_verified_at is not null and disabled_at is null)::int as n,
            count(*) filter (where email_verified_at is not null and disabled_at is null)::int as total
       from users`,
  );
  return { items: rows.rows, subscribers: subscribers.rows[0]?.n ?? 0, users: subscribers.rows[0]?.total ?? 0 };
}

export async function saveEmail(input: z.infer<typeof emailSchema>, actor: string) {
  if (input.id) {
    const updated = await db.query(
      `update marketing_emails set subject=$2,body=$3,audience=$4,updated_at=now() where id=$1 returning id`,
      [input.id, input.subject, input.body, JSON.stringify(input.audience)],
    );
    return updated.rows[0]?.id as string | undefined;
  }
  const created = await db.query<{ id: string }>(
    `insert into marketing_emails(subject,body,audience,created_by) values($1,$2,$3,$4) returning id`,
    [input.subject, input.body, JSON.stringify(input.audience), actor],
  );
  return created.rows[0]!.id;
}

/** Queues the campaign for everyone in its audience who has not received it yet. */
export async function sendEmail(id: string, baseUrl: string) {
  const client = await db.connect();
  try {
    await client.query("begin");
    const email = await client.query<{ subject: string; body: string; audience: EmailAudience }>(
      "select subject,body,audience from marketing_emails where id=$1 for update",
      [id],
    );
    const row = email.rows[0];
    if (!row) {
      await client.query("rollback");
      return null;
    }
    const audience = emailAudienceSchema.parse(row.audience ?? {});
    const condition = audienceCondition(audience, 2);
    const people = await client.query<{ id: string; email: string }>(
      `select u.id,u.email from users u
        where ${condition.sql}
          and not exists(select 1 from marketing_email_recipients r where r.email_id=$1 and r.user_id=u.id)
        order by u.created_at limit $2`,
      [id, MAX_RECIPIENTS_PER_SEND, ...condition.params],
    );
    let queued = 0;
    for (const person of people.rows) {
      const links = unsubscribeLinks(baseUrl, person.id);
      if (!links) throw new Error("mail_outbox_key_not_configured");
      await enqueueMail(
        { to: person.email, subject: row.subject, text: mailText(row.body, links.page), listUnsubscribe: links.oneClick },
        client,
      );
      await client.query(
        "insert into marketing_email_recipients(email_id,user_id) values($1,$2) on conflict do nothing",
        [id, person.id],
      );
      queued += 1;
    }
    await client.query(
      "update marketing_emails set status='sent',sent_at=coalesce(sent_at,now()),updated_at=now() where id=$1",
      [id],
    );
    await client.query("commit");
    const remaining = await audienceSize(audience, id);
    return { queued, remaining };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Sends the campaign to one address (the administrator's own) to check how it looks. */
export async function sendTestEmail(id: string, userId: string, to: string, baseUrl: string) {
  const email = await db.query<{ subject: string; body: string }>(
    "select subject,body from marketing_emails where id=$1",
    [id],
  );
  const row = email.rows[0];
  if (!row) return false;
  const links = unsubscribeLinks(baseUrl, userId);
  if (!links) throw new Error("mail_outbox_key_not_configured");
  await enqueueMail({
    to,
    subject: "[TEST] " + row.subject,
    text: mailText(row.body, links.page),
    listUnsubscribe: links.oneClick,
  });
  return true;
}

export async function setMarketingConsent(userId: string, optIn: boolean) {
  const result = await db.query(
    `update users set marketing_opt_in=$2,
            marketing_opt_in_at=case when $2 then now() else marketing_opt_in_at end,
            marketing_opt_out_at=case when $2 then marketing_opt_out_at else now() end
      where id=$1 and marketing_opt_in is distinct from $2`,
    [userId, optIn],
  );
  return (result.rowCount ?? 0) > 0;
}
