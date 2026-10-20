import { db } from "./db.js";
import { verifyApprovalClaim, type ApprovalRequest } from "./security.js";

export async function consumeApproval<T extends ApprovalRequest>(
  token: string | undefined | null,
  deviceId: string,
  request: T,
) {
  const claim = verifyApprovalClaim(token, deviceId, request);
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
    [claim.nonce, deviceId, request.kind],
  );

  return result.rowCount === 1;
}
