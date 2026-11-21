"use strict";

/**
 * @fileoverview Shared multer limits for every multipart upload route.
 *
 * `fieldArrayIndexLimit` closes multer GHSA-535w-7cp7-47q4: a field named
 * `a[4294967294]` followed by `a[x]` makes append-field walk a 4-billion-slot
 * array and freezes the event loop. The UI only sends flat field names
 * (`file`, `files`, `subject`, ...), so any bracket index is hostile.
 * The limit is opt-in in multer 2.5.0, which is why every route spreads this.
 */
const MULTIPART_FIELD_LIMITS = Object.freeze({
    fieldArrayIndexLimit: 100,
});

module.exports = Object.freeze({ MULTIPART_FIELD_LIMITS });
