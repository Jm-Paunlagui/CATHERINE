/**
 * @fileoverview emailDeliveryFailure.js — Pure helper shared by every feature
 * hook that consumes the additive `emailDelivery` response field (the
 * backend's Email Protection layer — see EmailProtectionService). Centralises
 * the "did email delivery fail on every tier?" decision and the shape handed
 * to `<EmailFailureModal>`, so each hook does not duplicate the same
 * branching.
 *
 * No React, no HTTP — plain transformation, safe to unit-test in isolation.
 */

/**
 * Builds the `{ flow, smtpCause, items }` object consumed by
 * `<EmailFailureModal>`, or `null` when there is nothing to surface.
 *
 * Two response shapes are handled, discriminated by which field is present:
 *   - Batch flows: `emailDelivery.failedItems[]` — a per-recipient array
 *     (only non-empty when BOTH the primary address AND the fallback tier
 *     failed for that item).
 *   - Single-recipient flows: a single `emailDelivery{}` with
 *     `status === 'FAILED'` — wrapped into a one-item array so
 *     `<EmailFailureModal>` renders it with the same list code path. The
 *     template fields for this item come from `emailPayload`, which services
 *     return as a SIBLING of `emailDelivery` in the response `data`
 *     (`return { ..., emailDelivery, emailPayload }`), never nested inside
 *     `emailDelivery` itself. The nested `emailDelivery.emailPayload` shape
 *     is also accepted for forward-compatibility.
 *
 * All backend fields are optional — a response from a flow where the
 * additive field never applies simply returns `null` here and the caller's
 * existing toast/error handling is unaffected.
 *
 * @param {object|null|undefined} data - The response envelope's `data` field (`res.data?.data`).
 * @param {string} flow - Flow discriminator forwarded verbatim to `<EmailFailureModal>`
 *   (an app-chosen label, e.g. `'record-submit'` — the modal passes it on to
 *   the caller's `renderItem` so one modal can serve several flows).
 * @returns {{ flow: string, smtpCause: string|null, items: Array<object> } | null}
 *
 * @example
 * const res = await recordApi.submit(payload);
 * const failure = extractEmailFailure(res.data?.data, "record-submit");
 * if (failure) setEmailFailure(failure);
 */
export function extractEmailFailure(data, flow) {
    const emailDelivery = data?.emailDelivery;
    if (!emailDelivery) return null;

    if (Array.isArray(emailDelivery.failedItems) && emailDelivery.failedItems.length > 0) {
        return { flow, smtpCause: emailDelivery.smtpCause ?? null, items: emailDelivery.failedItems };
    }

    if (emailDelivery.status === "FAILED") {
        return {
            flow,
            // Single-recipient flows only set `cause` (smtpCause exists only on
            // multi-recipient aggregates) — fall back so the modal's Alert never
            // reads "unknown SMTP error" while the real cause is available.
            smtpCause: emailDelivery.smtpCause ?? emailDelivery.cause ?? null,
            items: [
                {
                    // Backend returns `emailPayload` as a sibling of `emailDelivery`
                    // (data.emailPayload), never nested — see file header. The
                    // nested form is checked first only for forward-compatibility.
                    emailPayload: emailDelivery.emailPayload ?? data.emailPayload ?? {},
                    recipient: emailDelivery.recipient ?? null,
                    cause: emailDelivery.cause ?? emailDelivery.smtpCause ?? null,
                },
            ],
        };
    }

    return null;
}
