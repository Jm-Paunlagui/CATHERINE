"use strict";

/**
 * @file validateXlsxMagicBytes.test.js
 *
 * Unit tests for the validateXlsxMagicBytes middleware (CWE-434).
 *
 * Tests cover:
 *  - Happy path: valid ZIP/OOXML magic bytes → next() called without error
 *  - No file uploaded → next() called without error (controller handles it)
 *  - File buffer too small (<4 bytes) → next(AppError, 400)
 *  - Magic bytes mismatch (non-OOXML binary) → next(AppError, 400)
 *  - File with correct magic but wrong extension → accepted (magic wins)
 *  - req.file present but buffer is null/undefined → falls through
 */

const { expect } = require("chai");
const {
    validateXlsxMagicBytes,
} = require("../../../../src/utils/validateXlsxMagicBytes");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Creates a minimal req object with an optional req.file */
function mockReq(fileBuffer) {
    if (fileBuffer === undefined) {
        // No file property at all
        return { file: undefined };
    }
    if (fileBuffer === null) {
        // file present but buffer is null
        return { file: { buffer: null, originalname: "test.xlsx" } };
    }
    return {
        file: {
            buffer: fileBuffer,
            originalname: "test.xlsx",
            mimetype:
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
    };
}

/** Creates a minimal res (not used by this middleware but required by Express) */
function mockRes() {
    return {
        status(c) {
            this._status = c;
            return this;
        },
        json(b) {
            this._body = b;
        },
    };
}

/**
 * Builds a Buffer starting with the ZIP/OOXML magic bytes (50 4B 03 04)
 * followed by enough padding to simulate a real XLSX file.
 */
function validXlsxBuffer(extraBytes = 100) {
    const buf = Buffer.alloc(4 + extraBytes);
    buf[0] = 0x50; // 'P'
    buf[1] = 0x4b; // 'K'
    buf[2] = 0x03;
    buf[3] = 0x04;
    return buf;
}

/** Builds a Buffer that starts with PDF magic bytes (25 50 44 46 = %PDF). */
function pdfBuffer() {
    return Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x00]);
}

/** Builds a Buffer that starts with PE/EXE magic bytes (4D 5A = MZ). */
function exeBuffer() {
    return Buffer.from([0x4d, 0x5a, 0x00, 0x00, 0x00]);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("validateXlsxMagicBytes middleware (CWE-434)", function () {
    // ── Happy path ────────────────────────────────────────────────────────────

    describe("happy path — valid XLSX buffer", function () {
        it("calls next() without error for a valid OOXML/ZIP magic header", function (done) {
            const req = mockReq(validXlsxBuffer());
            validateXlsxMagicBytes(req, mockRes(), (err) => {
                expect(err).to.be.undefined;
                done();
            });
        });

        it("accepts a buffer that is exactly 4 bytes (minimum valid length)", function (done) {
            const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
            const req = mockReq(buf);
            validateXlsxMagicBytes(req, mockRes(), (err) => {
                expect(err).to.be.undefined;
                done();
            });
        });

        it("accepts a large realistic buffer with correct magic bytes", function (done) {
            const req = mockReq(validXlsxBuffer(1024 * 100)); // 100 KB
            validateXlsxMagicBytes(req, mockRes(), (err) => {
                expect(err).to.be.undefined;
                done();
            });
        });
    });

    // ── No file / null buffer — pass through ─────────────────────────────────

    describe("no file uploaded — pass through", function () {
        it("calls next() without error when req.file is undefined", function (done) {
            const req = mockReq(undefined);
            validateXlsxMagicBytes(req, mockRes(), (err) => {
                expect(err).to.be.undefined;
                done();
            });
        });

        it("calls next() without error when req.file is null", function (done) {
            const req = { file: null };
            validateXlsxMagicBytes(req, mockRes(), (err) => {
                expect(err).to.be.undefined;
                done();
            });
        });

        it("calls next() without error when req.file.buffer is null", function (done) {
            const req = mockReq(null); // file present, buffer null
            validateXlsxMagicBytes(req, mockRes(), (err) => {
                expect(err).to.be.undefined;
                done();
            });
        });
    });

    // ── Buffer too small ──────────────────────────────────────────────────────

    describe("buffer too small — rejected", function () {
        it("calls next(AppError) when buffer has 0 bytes", function (done) {
            const req = mockReq(Buffer.alloc(0));
            validateXlsxMagicBytes(req, mockRes(), (err) => {
                expect(err).to.be.an("error");
                expect(err.statusCode).to.equal(400);
                expect(err.message).to.match(/too small|valid.*xlsx/i);
                done();
            });
        });

        it("calls next(AppError) when buffer has only 3 bytes", function (done) {
            const req = mockReq(Buffer.from([0x50, 0x4b, 0x03]));
            validateXlsxMagicBytes(req, mockRes(), (err) => {
                expect(err).to.be.an("error");
                expect(err.statusCode).to.equal(400);
                done();
            });
        });

        it("AppError.details array is present for undersized buffer", function (done) {
            const req = mockReq(Buffer.from([0x50]));
            validateXlsxMagicBytes(req, mockRes(), (err) => {
                expect(err).to.have.property("details").that.is.an("array");
                expect(err.details[0]).to.have.property("field", "file");
                done();
            });
        });
    });

    // ── Magic bytes mismatch ──────────────────────────────────────────────────

    describe("magic bytes mismatch — rejected", function () {
        it("rejects a PDF buffer (%PDF header)", function (done) {
            const req = mockReq(pdfBuffer());
            validateXlsxMagicBytes(req, mockRes(), (err) => {
                expect(err).to.be.an("error");
                expect(err.statusCode).to.equal(400);
                expect(err.message).to.match(/magic bytes|valid.*xlsx/i);
                done();
            });
        });

        it("rejects a Windows EXE/PE buffer (MZ header)", function (done) {
            const req = mockReq(exeBuffer());
            validateXlsxMagicBytes(req, mockRes(), (err) => {
                expect(err).to.be.an("error");
                expect(err.statusCode).to.equal(400);
                done();
            });
        });

        it("rejects a buffer of all-zero bytes", function (done) {
            const req = mockReq(Buffer.alloc(16));
            validateXlsxMagicBytes(req, mockRes(), (err) => {
                expect(err).to.be.an("error");
                expect(err.statusCode).to.equal(400);
                done();
            });
        });

        it("rejects a buffer starting with 50 4B 03 05 (not exactly 03 04)", function (done) {
            const buf = Buffer.from([0x50, 0x4b, 0x03, 0x05, 0x00, 0x00]);
            const req = mockReq(buf);
            validateXlsxMagicBytes(req, mockRes(), (err) => {
                expect(err).to.be.an("error");
                expect(err.statusCode).to.equal(400);
                done();
            });
        });

        it("AppError.name is 'ValidationError' for mismatch", function (done) {
            const req = mockReq(pdfBuffer());
            validateXlsxMagicBytes(req, mockRes(), (err) => {
                expect(err.name).to.equal("ValidationError");
                done();
            });
        });

        it("AppError.details[0].field is 'file' for mismatch", function (done) {
            const req = mockReq(exeBuffer());
            validateXlsxMagicBytes(req, mockRes(), (err) => {
                expect(err).to.have.property("details").that.is.an("array");
                expect(err.details[0]).to.have.property("field", "file");
                done();
            });
        });
    });

    // ── Correct magic, wrong extension (extension spoofing attempted) ─────────

    describe("extension vs magic — magic wins", function () {
        it("accepts a buffer with valid OOXML magic even if originalname ends in .csv", function (done) {
            // Magic bytes check only looks at the buffer — not the filename.
            // This is by design; MIME and extension checking is done by multer fileFilter.
            const req = {
                file: {
                    buffer: validXlsxBuffer(),
                    originalname: "data.csv",
                    mimetype: "text/csv",
                },
            };
            validateXlsxMagicBytes(req, mockRes(), (err) => {
                // Middleware should pass — it only checks the bytes.
                expect(err).to.be.undefined;
                done();
            });
        });
    });
});
