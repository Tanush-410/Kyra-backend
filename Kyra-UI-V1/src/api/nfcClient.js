import { API_BASE, getToken } from "../config.js";
import { KyraApiError } from "./kyraClient.js";

/**
 * KYRA AI NFC Tags: the kiosk's side of backend/src/routes/nfc.js. Kept apart from kyraClient.js so the
 * whole Kyra Tag feature is easy to find (this file, screens/nfc/, lib/nfcRoutes.js).
 *
 * The kiosk never talks to the Raspberry Pi and never sees its device token: it asks the backend for a tag
 * job, and the Pi takes the job from the backend. A job is only "succeeded" once the Pi has written the tag,
 * read it back and confirmed the URL.
 */

async function request(path, { method = "GET", body } = {}) {
  const token = getToken();
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new KyraApiError("I can't reach the mirror right now.", { code: "offline" });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new KyraApiError(data.error || "Something went wrong.", { status: response.status, code: data.code || "" });
  return data;
}

const session = (id) => `/api/v2/sessions/${encodeURIComponent(id)}`;
const job = (id) => `/api/v2/nfc/jobs/${encodeURIComponent(id)}`;

/** The states a tag job goes through. Only "succeeded" means a programmed tag. */
export const TAG_ACTIVE = ["queued", "waiting_for_tag", "writing", "verifying"];
export const TAG_FINAL = ["succeeded", "failed", "cancelled"];

export const nfcApi = {
  /** { enabled, deviceOnline }: the prompt is offered only when both are true. */
  status: () => request("/api/v2/nfc/status"),
  /** The visit's short link (https://kyra.style/s/…): { token, url, expiresAt, qrDataUrl }. */
  link: (sessionId) => request(`${session(sessionId)}/link`, { method: "POST", body: {} }),
  /** YES: ask for a tag. { jobId, status, error, deviceOnline } */
  issue: (sessionId) => request(`${session(sessionId)}/nfc/issue`, { method: "POST", body: {} }),
  job: (jobId) => request(job(jobId)),
  cancel: (jobId) => request(`${job(jobId)}/cancel`, { method: "POST", body: {} }),
};

/** What the visitor reads for each job status. */
export function tagStatusText(status, error) {
  switch (status) {
    case "queued":
      return { title: "Preparing your Kyra Tag", text: "One moment…" };
    case "waiting_for_tag":
      return { title: "Waiting for a blank NFC tag", text: "Place a blank Kyra Tag on the reader." };
    case "writing":
    case "verifying":
      return { title: "Writing your personalised URL", text: "Keep the tag on the reader." };
    case "succeeded":
      return { title: "Tag successfully programmed", text: "Tap it with your phone to open your Kyra Canvas." };
    case "failed":
      return { title: "Programming failed", text: `${FAILURE_HINTS[error] || "Something went wrong."} Please try again.` };
    default:
      return { title: "Preparing your Kyra Tag", text: "" };
  }
}

const FAILURE_HINTS = {
  no_tag: "No tag was placed on the reader in time.",
  timed_out: "The tag writer didn't answer in time.",
  tag_not_blank: "That tag already holds something, so it wasn't changed. Use a blank tag.",
  read_only: "That tag is locked and can't be written.",
  insufficient_capacity: "That tag is too small for the link.",
  not_ndef_formatted: "That tag isn't the right kind.",
  tag_removed: "The tag was moved off the reader too soon.",
  write_failed: "The tag couldn't be written.",
  verify_mismatch: "The tag didn't read back correctly.",
  read_failed: "The tag couldn't be read.",
};
