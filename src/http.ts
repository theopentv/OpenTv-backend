import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * The stable machine strings the app switches on. `message` is English and for
 * logs and last-resort display only — the app ships in six languages and
 * localises from `code`, so the server has no business guessing which
 * (docs/IMPLEMENTATION.md, "Error envelope").
 *
 * Status codes: 400 invalid body, 401 no/bad session, 403 blocked or not
 * yours, 404 missing, 409 conflict, 429 rate limited, 500 unexpected.
 */
export type ErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  // The act needs OpenTV Plus. Its own code, not `forbidden`: the app answers
  // it with the paywall, which is a different response from "you may not".
  | 'plus_required'
  | 'not_found'
  | 'invalid_body'
  | 'handle_taken'
  /** The claim volunteered a TV Time id that already sits on another profile.
   *  See the note in `POST /v1/me/handle` for what that does and does not
   *  prove. */
  | 'tvtime_id_claimed'
  | 'handle_invalid'
  | 'rate_limited'
  | 'target_invalid'
  | 'too_large'
  | 'blocked'
  // The image binding is absent from this deployment — a capability that is
  // off, not a request that was wrong.
  | 'unavailable'
  // An upload that is not one of the image types the bucket accepts.
  | 'unsupported_type'
  // The translation model failed or was rate-limited. TRANSIENT, and its own
  // code so the app can offer "try again" rather than hiding the row for good —
  // `unavailable` means the capability is off, which is permanent from the
  // phone's point of view.
  | 'translate_failed'
  // The dashboard's gift to a paying subscriber: Apple or Google said no.
  | 'store_refused'
  // A personal offer (0061): one is already running, or this person has had
  // this one before. Either way the countdown cannot start again.
  | 'offer_running'
  | 'offer_given'
  // Signed in, but the email address behind the account is still unconfirmed.
  // Its own code rather than a plain `forbidden` because the app has to tell
  // these apart: one is "you may not", the other is "finish this first", and
  // only the second has a screen to send somebody to.
  | 'email_unverified'
  // Sign-in against an address with no account at all. Its own code because
  // "wrong password" sends somebody to try again at a door that is not there,
  // and the only useful reply is "create one".
  | 'no_account'
  // Sign-in against an address whose account uses Apple or Google. The reply
  // carries a `providers` array alongside the envelope so the app can name it.
  | 'use_provider'
  // Another of this person's own phones publishes the profile (0052). A 409
  // and its own code: the request was well-formed and the app's answer is
  // "make this phone main", not a retry and not the paywall on its own.
  | 'not_publisher'
  // Sync from a device the owner removed from their list (0054). Its own code
  // because the phone's answer is to switch sync off and say so once — a plain
  // `forbidden` would read as "sign in again", which is the wrong sentence.
  | 'device_removed'
  // A NEW device, and the account already syncs on its full set. Different
  // from `device_removed` because the fix is different: remove one you no
  // longer use, then come back.
  | 'device_limit'
  // A capability this deployment does not have at all — the live room on a
  // self-hosted instance, which has no Durable Object runtime. The app hides
  // the feature rather than offering "try again".
  | 'not_configured'
  // The live room's 48 h window is over (or not yet open). Its own code so the
  // app draws "The room closed" instead of an error.
  | 'room_closed'
  // 2,000 sockets in one room, or five from one account.
  | 'room_full'
  // The live room's socket route asked for without a WebSocket upgrade.
  | 'upgrade_required'
  | 'internal';

/** Every failure response in the API. Success responses are the bare resource. */
export function fail(c: Context, status: ContentfulStatusCode, code: ErrorCode, message: string) {
  return c.json({ error: { code, message } }, status);
}
