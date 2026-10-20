import { db } from "./db.js";
import { verifyApprovalClaim } from "./security.js";

export async function consumeApproval(
  token: string | undefined | null,
  deviceId: string,
  action: string,
) {
  const claim = verifyApprovalClaim(token, deviceId, action);
  if (!claim) return false;

  const result = await db.query(
    `update approvals
       set consumed_at=now()
     where nonce=$1
       and device_id=$2
       and action=$3
       and expires_at>now()
       and consumed_at is null
     returning id`,
    [claim.nonce, deviceId, action],
  );

  return result.rowCount === 1;
}
