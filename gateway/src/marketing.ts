import { z } from "zod";
import { db } from "./db.js";

// Marketing: in-app messages and surveys. A campaign targets platforms,
// plans and account age; each user sees it at most once (until they answer,
// close or click it), and the console sees the answers.

export const CAMPAIGN_KINDS = ["csat", "nps", "announcement", "tip"] as const;
export const PLATFORMS = ["windows", "macos", "linux", "web"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const audienceSchema = z.object({
  platforms: z.array(z.enum(PLATFORMS)).max(4).default([]),
  plans: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  minDays: z.number().int().min(0).max(3650).nullable().default(null),
  maxDays: z.number().int().min(0).max(3650).nullable().default(null),
});
export type Audience = z.infer<typeof audienceSchema>;

export const campaignSchema = z.object({
  id: z.string().uuid().optional(),
  kind: z.enum(CAMPAIGN_KINDS),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().max(600).default(""),
  ctaLabel: z.string().trim().max(40).nullable().default(null),
  ctaUrl: z.string().trim().url().max(500).refine((u) => u.startsWith("https://"), "https only").nullable().default(null),
  audience: audienceSchema.default({ platforms: [], plans: [], minDays: null, maxDays: null }),
  startsAt: z.string().datetime({ offset: true }).nullable().default(null),
  endsAt: z.string().datetime({ offset: true }).nullable().default(null),
});

export const responseSchema = z.object({
  id: z.string().uuid(),
  platform: z.enum(PLATFORMS),
  action: z.enum(["shown", "answered", "dismissed", "clicked"]),
  score: z.number().int().min(0).max(10).nullable().default(null),
  comment: z.string().trim().max(1000).nullable().default(null),
});

/** Whether a user (on `platform`, on plan `plan`, `ageDays` after signing up) is in the audience. */
export function inAudience(audience: Audience, platform: Platform, plan: string | null, ageDays: number): boolean {
  if (audience.platforms.length > 0 && !audience.platforms.includes(platform)) return false;
  if (audience.plans.length > 0 && !(plan !== null && audience.plans.includes(plan))) return false;
  if (audience.minDays !== null && ageDays < audience.minDays) return false;
  if (audience.maxDays !== null && ageDays > audience.maxDays) return false;
  return true;
}

/** The score a survey answer may have: 1–5 for satisfaction, 0–10 for NPS, none otherwise. */
export function validScore(kind: string, score: number | null): boolean {
  if (kind === "csat") return score !== null && score >= 1 && score <= 5;
  if (kind === "nps") return score !== null && score >= 0 && score <= 10;
  return score === null;
}

type Row = {
  id: string; kind: string; title: string; body: string; cta_label: string | null; cta_url: string | null;
  audience: Audience; created_at: string;
};

/** The newest message this user has not answered, closed or clicked yet. */
export async function nextMessage(userId: string, organizationId: string | null, platform: Platform) {
  const user = await db.query<{ age_days: number }>(
    "select floor(extract(epoch from now()-created_at)/86400)::int as age_days from users where id=$1",
    [userId],
  );
  if (!user.rowCount) return null;
  const plan = organizationId
    ? (await db.query<{ plan_key: string }>(
        "select plan_key from organization_subscriptions where organization_id=$1 and status in ('trialing','active','past_due')",
        [organizationId],
      )).rows[0]?.plan_key ?? null
    : null;
  const rows = await db.query<Row>(
    `select c.id,c.kind,c.title,c.body,c.cta_label,c.cta_url,c.audience,c.created_at
       from marketing_campaigns c
       left join marketing_responses r on r.campaign_id=c.id and r.user_id=$1
      where c.status='active'
        and (c.starts_at is null or c.starts_at<=now())
        and (c.ends_at is null or c.ends_at>now())
        and (r.action is null or r.action='shown')
      order by c.created_at desc limit 20`,
    [userId],
  );
  const age = user.rows[0]?.age_days ?? 0;
  const pick = rows.rows.find((c) => inAudience(audienceSchema.parse(c.audience ?? {}), platform, plan, age));
  if (!pick) return null;
  return {
    id: pick.id, kind: pick.kind, title: pick.title, body: pick.body,
    ctaLabel: pick.cta_label, ctaUrl: pick.cta_url,
  };
}

/** Records what the user did; an answer or a close is final, "shown" never overwrites them. */
export async function recordResponse(userId: string, input: z.infer<typeof responseSchema>) {
  const campaign = await db.query<{ kind: string }>(
    "select kind from marketing_campaigns where id=$1 and status='active'", [input.id],
  );
  const kind = campaign.rows[0]?.kind;
  if (!kind) return { ok: false as const, error: "campaign_not_active" };
  const score = input.action === "answered" ? input.score : null;
  if (input.action === "answered" && !validScore(kind, score)) return { ok: false as const, error: "invalid_score" };
  await db.query(
    `insert into marketing_responses(campaign_id,user_id,platform,action,score,comment)
     values($1,$2,$3,$4,$5,$6)
     on conflict (campaign_id,user_id) do update
       set action=excluded.action, score=excluded.score, comment=excluded.comment,
           platform=excluded.platform, updated_at=now()
       where marketing_responses.action='shown'`,
    [input.id, userId, input.platform, input.action, score, input.action === "answered" ? input.comment : null],
  );
  return { ok: true as const };
}

/** Console list: every campaign with how many saw, answered, closed and clicked it. */
export async function listCampaigns() {
  const r = await db.query(
    `select c.*,
            count(r.*) filter (where true)::int as reached,
            count(r.*) filter (where r.action='answered')::int as answered,
            count(r.*) filter (where r.action='dismissed')::int as dismissed,
            count(r.*) filter (where r.action='clicked')::int as clicked,
            round(avg(r.score) filter (where r.action='answered'),2)::float as average
       from marketing_campaigns c left join marketing_responses r on r.campaign_id=c.id
      group by c.id order by c.created_at desc limit 200`,
  );
  return r.rows;
}

/** Console results: score distribution, NPS and the newest comments. */
export async function campaignResults(id: string) {
  const campaign = await db.query("select * from marketing_campaigns where id=$1", [id]);
  if (!campaign.rowCount) return null;
  const dist = await db.query<{ score: number; n: number }>(
    "select score,count(*)::int as n from marketing_responses where campaign_id=$1 and action='answered' and score is not null group by score order by score",
    [id],
  );
  const platforms = await db.query<{ platform: string; n: number }>(
    "select platform,count(*)::int as n from marketing_responses where campaign_id=$1 group by platform", [id],
  );
  const comments = await db.query(
    `select r.score,r.comment,r.platform,r.updated_at,u.email
       from marketing_responses r join users u on u.id=r.user_id
      where r.campaign_id=$1 and r.comment is not null and r.comment<>''
      order by r.updated_at desc limit 200`,
    [id],
  );
  return {
    campaign: campaign.rows[0],
    distribution: dist.rows,
    nps: npsScore(dist.rows),
    platforms: platforms.rows,
    comments: comments.rows,
  };
}

/** Net Promoter Score from a 0–10 distribution: % promoters (9–10) minus % detractors (0–6). */
export function npsScore(distribution: Array<{ score: number; n: number }>): number | null {
  const total = distribution.reduce((s, d) => s + d.n, 0);
  if (total === 0) return null;
  const promoters = distribution.filter((d) => d.score >= 9).reduce((s, d) => s + d.n, 0);
  const detractors = distribution.filter((d) => d.score <= 6).reduce((s, d) => s + d.n, 0);
  return Math.round(((promoters - detractors) * 100) / total);
}

export async function saveCampaign(input: z.infer<typeof campaignSchema>, actor: string) {
  const values = [input.kind, input.title, input.body, input.ctaLabel, input.ctaUrl, JSON.stringify(input.audience), input.startsAt, input.endsAt];
  if (input.id) {
    const r = await db.query(
      `update marketing_campaigns set kind=$1,title=$2,body=$3,cta_label=$4,cta_url=$5,audience=$6,starts_at=$7,ends_at=$8,updated_at=now()
        where id=$9 returning id`,
      [...values, input.id],
    );
    return r.rows[0]?.id as string | undefined;
  }
  const r = await db.query(
    `insert into marketing_campaigns(kind,title,body,cta_label,cta_url,audience,starts_at,ends_at,created_by)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [...values, actor],
  );
  return r.rows[0]?.id as string;
}
