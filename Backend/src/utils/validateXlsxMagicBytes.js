"use strict";

/**
 * validateXlsxMagicBytes.js
 *
 * Express middleware that verifies the uploaded file's magic bytes match a
 * valid OOXML / ZIP archive (50 4B 03 04) before the body reaches the service
 * layer. This closes the gap left by MIME-type / extension checking alone
 * (CWE-434 / Security finding #11).
 *
 * Usage (after multer.single("file") in a route):
 *   router.post('/upload',
 *     upload.single('file'),
 *     validateXlsxMagicBytes,
 *     MyController.upload,
 *   );
 *
 * Why after multer:
 *   multer must read the body before req.file.buffer is populated, so the
 *   check must run after multer, not inside fileFilter (which has no buffer).
 *
 * @module validateXlsxMagicBytes
 */

const { AppError } = require("../constants/errors");
const { HTTP_STATUS } = require("../constants");

/**
 * ZIP / OOXML magic signature: 50 4B 03 04 (first 4 bytes of a ZIP archive).
 * All .xlsx files are ZIP archives containing XML parts, so this signature
 * applies universally. An .xlsx renamed from a non-ZIP format will fail here.
 *
 * @type {Buffer}
 */
const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * Express middleware: rejects uploads whose first 4 bytes do not match the
 * OOXML/ZIP magic signature (50 4B 03 04).
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function validateXlsxMagicBytes(req, res, next) {
    if (!req.file || !req.file.buffer) {
        // No file uploaded — let the controller handle the missing-file error.
        return next();
    }

    const buf = req.file.buffer;

    if (buf.length < 4) {
        return next(
            new AppError(
                "Uploaded file is too small to be a valid .xlsx file.",
                HTTP_STATUS.BAD_REQUEST,
                {
                    type: "ValidationError",
                    details: [
                        {
                            field: "file",
                            issue: "File must be a valid .xlsx (OOXML) workbook.",
                        },
                    ],
                },
            ),
        );
    }

    const header = buf.slice(0, 4);
    if (!header.equals(XLSX_MAGIC)) {
        return next(
            new AppError(
                "Uploaded file does not appear to be a valid .xlsx file (magic bytes mismatch).",
                HTTP_STATUS.BAD_REQUEST,
                {
                    type: "ValidationError",
                    details: [
                        {
                            field: "file",
                            issue:
                                "File must be a valid .xlsx (OOXML) workbook. " +
                                "Renaming a non-Excel file to .xlsx is not accepted.",
                        },
                    ],
                },
            ),
        );
    }

    next();
}

module.exports = { validateXlsxMagicBytes };
