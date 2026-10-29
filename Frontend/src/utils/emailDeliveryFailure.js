/**
 * @fileoverview emailDeliveryFailure.js — Pure helper shared by every feature
 * hook that consumes the additive `emailDelivery` response field (Data
 * Protection + Email Protection reliability layer). Centralises the
 * "did email delivery fail on every tier?" decision and the shape handed to
 * `<EmailFailureModal>`, so each hook does not duplicate the same branching.
 *
 * No React, no HTTP — plain transformation, safe to unit-test in isolation.
 */

/**
 * Builds the `{ flow, smtpCause, items, requestId }` object consumed by
 * `<EmailFailureModal>`, or `null` when there is nothing to surface.
 *
 * Two response shapes are handled, discriminated by which field is present:
 *   - Multi-recipient flows: `emailDelivery.failedItems[]` — a per-recipient
 *     array (only non-empty when every delivery tier failed for that item).
 *   - Single-recipient flows: a single `emailDelivery{}` with
 *     `status === 'FAILED'` — wrapped into a one-item array so the modal renders
 *     both shapes through one list code path. The item's template fields come
 *     from `emailPayload`, which services return as a SIBLING of
 *     `emailDelivery` in the response `data` (`return { ..., emailDelivery,
 *     emailPayload }`). The nested `emailDelivery.emailPayload` shape is also
 *     accepted for forward-compatibility.
 *
 * All new backend fields are optional — a response from a not-yet-updated
 * backend (or a flow where the additive field never applies) simply returns
 * `null` here and the caller's existing toast/error handling is unaffected.
 *
 * @param {object|null|undefined} data - The response envelope's `data` field (`res.data?.data`).
 * @param {string} flow - App-chosen label for the action that sent the email (e.g.
 *   `'record-submit'`), kept on the result so the caller can tell failures apart.
 *   `<EmailFailureModal>` itself takes `{ open, smtpCause, items, requestId, onDismiss }`.
 * @param {string|null} [requestId] - The response envelope's root-level `requestId`
 *   (`res.data?.requestId`), injected by the backend's `TraceabilityMiddleware` into
 *   every JSON response. Forwarded to `<EmailFailureModal>` so the operator can quote
 *   it to support when tracing the failed-delivery incident in the Audit Logs.
 * @returns {{ flow: string, smtpCause: string|null, items: Array<object>, requestId: string|null } | null}
 *
 * @example
 * const res = await recordApi.submit(payload);
 * const failure = extractEmailFailure(res.data?.data, "record-submit", res.data?.requestId ?? null);
 * if (failure) setEmailFailure(failure);
 */
export function extractEmailFailure(data, flow, requestId = null) {
    const emailDelivery = data?.emailDelivery;
    if (!emailDelivery) return null;

    if (Array.isArray(emailDelivery.failedItems) && emailDelivery.failedItems.length > 0) {
        return { flow, smtpCause: emailDelivery.smtpCause ?? null, items: emailDelivery.failedItems, requestId };
    }

    if (emailDelivery.status === "FAILED") {
        return {
            flow,
            // Single-recipient flows only set `cause` (smtpCause exists only on
            // multi-recipient aggregates) — fall back so
            // the modal's Alert never reads "unknown SMTP error" while the real
            // cause is available.
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
            requestId,
        };
    }

    return null;
}
