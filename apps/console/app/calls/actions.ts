"use server";
import { revalidatePath } from "next/cache";
import { apiPost } from "@/lib/api";

export type TestCallResult = { ok: boolean; message: string };

interface TestCallResponse {
  call_task_id: string;
  assistant_id: string | null;
  dial_mode: string;
}

/**
 * Place one test call.
 *
 * `attestedBy` is typed by the operator for the same reason `reviewed_by` is on the review screen:
 * the console has no authentication, so the name on the consent record is self-asserted. Here it
 * matters more than there — it lands in `consent_event`, which is append-only evidence that the
 * number was lawfully dialable. A blank name must therefore stop the call, not default to
 * "console".
 */
export async function placeTestCall(
  phone: string,
  attestedBy: string,
  attested: boolean,
  assistantId: string,
): Promise<TestCallResult> {
  const number = phone.trim();
  const name = attestedBy.trim();

  if (!/^\+[1-9]\d{7,14}$/.test(number)) {
    return { ok: false, message: "Enter the number in E.164 — a leading + and country code, e.g. +14045550100." };
  }
  if (!name) return { ok: false, message: "Enter your name. It goes on the consent record for this number." };
  if (!attested) {
    return { ok: false, message: "Tick the attestation. This number is dialled for real, and the consent record is only honest if a person stands behind it." };
  }

  const r = await apiPost<TestCallResponse>("/test-calls", {
    phone: number,
    attestation: true,
    attested_by: name,
    ...(assistantId.trim() ? { assistant_id: assistantId.trim() } : {}),
  }, { internal: true });

  if (r.status === 202 && r.data) {
    revalidatePath("/calls");
    return {
      ok: true,
      message:
        `Queued for ${number} on assistant ${r.data.assistant_id ?? "(deployment default)"} in ${r.data.dial_mode}. ` +
        "It still has to pass the pre-dial gate — if it does not, it will appear under Blocked below rather than in the log.",
    };
  }
  if (r.status === 409) {
    return { ok: false, message: "The api has no active script version or no account to file the contact under, so it refused to create the task." };
  }
  if (r.status === 400) {
    return { ok: false, message: "The api rejected the request. Check the number is E.164 and try again." };
  }
  return { ok: false, message: `Could not reach the api (status ${r.status}). The call was not placed.` };
}
