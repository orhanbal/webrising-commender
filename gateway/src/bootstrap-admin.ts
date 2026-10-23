import { readFileSync } from "node:fs";
import { db, migrate } from "./db.js";
import { hashPassword, normalizeEmail } from "./browser-auth.js";

async function main() {
  const email = normalizeEmail(process.argv[2] || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    throw new Error("Provide the intended administrator email as the sole command argument");
  }
  if (process.stdin.isTTY) throw new Error("Pipe a password through stdin; interactive terminal input is not supported");
  const password = readFileSync(0, "utf8").replace(/\r?\n$/, "");
  if (password.length < 12 || password.length > 256) throw new Error("Password must be 12–256 characters");
  const hash = await hashPassword(password);
  await migrate();
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('wecommander:platform-admin-bootstrap'))");
    const prior = await client.query("select 1 from platform_administrators where revoked_at is null limit 1");
    if (prior.rowCount) throw new Error("Platform administrator already exists; bootstrap refused");
    const user = await client.query<{id:string}>(
      `insert into users(email,password_hash,email_verified_at)
       values($1,$2,now()) on conflict ((lower(email))) do nothing returning id`,
      [email,hash],
    );
    if (!user.rows[0]) throw new Error("User already exists; refusing to overwrite its password");
    const workspace = await client.query<{id:string}>(
      "insert into organizations(name) values($1) returning id",
      ["WECOMMANDER Admin"],
    );
    await client.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",
      [workspace.rows[0].id,user.rows[0].id]);
    await client.query("insert into platform_administrators(user_id,granted_by) values($1,$2)",
      [user.rows[0].id,"server-local-bootstrap"]);
    await client.query(
      "insert into platform_admin_audit(actor_user_id,action,detail) values($1,'platform.bootstrap','initial platform administrator created')",
      [user.rows[0].id],
    );
    await client.query("commit");
    process.stdout.write("Platform administrator created. Login with the selected email and password.\n");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { client.release(); }
}
main().catch(error => { process.stderr.write(String(error instanceof Error?error.message:error)+"\n"); process.exitCode=1; }).finally(()=>db.end());
