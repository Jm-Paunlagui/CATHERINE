/**
 * TemporaryPasswordRecipient — where the emailed temporary password goes.
 *
 * Used by the Add Admin and Reset Password dialogs. The server generates the
 * password and emails it; this component only says where it will go and, when
 * the account profile has no address, collects one. That typed address is used
 * once and never saved.
 *
 * Props:
 *   id            — input id (unique per dialog)
 *   emailHint     — masked profile address, e.g. "j***@corp.com", or null
 *   needsEmail    — true when the profile has no usable address (or the server said so)
 *   value         — typed address
 *   onChange      — (value: string) => void
 */

import { EnvelopeIcon } from "@heroicons/react/24/outline";
import { Input } from "../../../../components/forms/Input";
import { Alert } from "../../../../components/ui/Alert";

/** Copy shown when no usable address is on file. */
const MISSING_ADDRESS_COPY = {
    title: "No email address on file",
    body: "Enter the address the temporary password should be sent to. Add it to the account profile so this is not needed next time.",
};

export function TemporaryPasswordRecipient({ id, emailHint = null, needsEmail = false, value = "", onChange }) {
    const copy = MISSING_ADDRESS_COPY;
    return (
        <div className="space-y-3">
            <p className="text-xs font-aumovio-bold text-black/70 dark:text-white/70">Temporary password</p>

            {needsEmail ? (
                <>
                    <Alert variant="warning" size="sm" title={copy.title}>
                        {copy.body}
                    </Alert>
                    <Input id={id} name={id} type="email" label="Email" value={value} onChange={(e) => onChange(e.target.value)} placeholder="name@example.com" leftIcon={EnvelopeIcon} helper="Used once to send the temporary password. It is not saved." autoComplete="off" required />
                </>
            ) : (
                <Alert variant="info" size="sm" icon={EnvelopeIcon}>
                    A temporary password will be emailed to <strong>{emailHint ?? "the address on file"}</strong>. It works for 72 hours and can only be used to set a new password.
                </Alert>
            )}
        </div>
    );
}

export default TemporaryPasswordRecipient;
