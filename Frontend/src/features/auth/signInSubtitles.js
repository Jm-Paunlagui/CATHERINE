/**
 * signInSubtitles.js — rotating sign-in greetings for the auth screen.
 *
 * Every entry is exactly 44 characters (the length of "Welcome back! Please
 * sign in to your account") so the card layout never reflows whichever line is
 * shown. A project may replace the pool with its own copy — keep the length.
 */

/** @type {readonly string[]} */
export const SIGN_IN_SUBTITLES = Object.freeze([
    "Welcome back! Please sign in to your account",
    "Welcome back! Sign in to open your dashboard",
    "Welcome back! Sign in to see your dashboard.",
    "Welcome back! Please sign in to get started.",
    "Welcome back! Sign in to resume your session",
    "Hello again! Please sign in to your account.",
    "Hello again! Sign in to open your dashboard.",
    "Hello again! Sign in to resume your session.",
    "Hello again! Sign in to reach your workspace",
    "Hey there! Please sign in with your account.",
    "Good to see you! Please sign in to continue.",
    "Good to see you! Sign in to get back to work",
    "Great to see you! Please sign in to continue",
    "Great to see you! Sign in with your account.",
    "Nice to see you! Please sign in to continue.",
    "Nice to see you! Sign in to get back to work",
    "Happy to see you! Please sign in to continue",
    "Happy to see you! Sign in with your account.",
    "Good to have you back! Sign in to keep going",
    "Glad you are here! Sign in with your account",
    "Ready when you are! Sign in to your account.",
    "Back again? Sign in to reach your workspace.",
    "Back again? Please sign in with your account",
    "Greetings! Please sign in with your account.",
    "Welcome aboard! Sign in to get back to work.",
    "Welcome aboard! Sign in and let us get going",
]);

/**
 * Pick one greeting at random.
 *
 * @param {() => number} [random=Math.random] - Injectable for tests.
 * @returns {string} A subtitle guaranteed to be 44 characters long.
 */
export function pickSignInSubtitle(random = Math.random) {
    return SIGN_IN_SUBTITLES[Math.floor(random() * SIGN_IN_SUBTITLES.length)] ?? SIGN_IN_SUBTITLES[0];
}
