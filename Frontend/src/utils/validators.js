/**
 * validators.js — Pure validation functions. No side effects.
 */

export const EMAIL_REGEX = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

export function isValidEmail(email) {
    return typeof email === "string" && EMAIL_REGEX.test(email.trim());
}

/** Min 8 chars, at least one letter and one digit */
export function isStrongPassword(password) {
    return typeof password === "string" && password.length >= 8 && /[a-zA-Z]/.test(password) && /\d/.test(password);
}

export function isNonEmpty(value) {
    return typeof value === "string" && value.trim().length > 0;
}

export function isPositiveInt(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0;
}

/**
 * Validate required fields on an object.
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateRequired(data, fields) {
    const missing = fields.filter((f) => data[f] === undefined || data[f] === null || data[f] === "");
    return { valid: missing.length === 0, missing };
}
