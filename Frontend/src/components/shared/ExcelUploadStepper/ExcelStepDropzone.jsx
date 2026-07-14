/**
 * ExcelStepDropzone.jsx — Shared Step 1 component for all Excel upload steppers.
 *
 * Renders the requirements info panel, react-dropzone area, file-type/size
 * error banner, file info card (with optional intra-file duplicate warning),
 * and the Proceed button.
 *
 * Receives all data via props. Never imports any feature hook or API file.

 * Replaces per-feature Step 1 upload components.
 */

import { faCheck, faCheckCircle, faExclamationCircle, faExclamationTriangle, faFileExcel, faXmark } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { CloudArrowUpIcon } from "@heroicons/react/24/outline";
import PropTypes from "prop-types";
import { useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { ANIMATE_FADE_IN_UP, ANIMATE_SHAKE, TITLE_COLOR_TEXT, TRANSITION_COLORS } from "../../../assets/styles/pre-set-styles";
import Button from "../../ui/Button";

/**
 * Step 1 dropzone component for any 3-step Excel upload stepper.
 *
 * @param {object}        props
 * @param {File|null}     props.uploadFile           - Currently selected file, or null.
 * @param {Array<object>} [props.parsedRows=[]]      - SheetJS-parsed rows for row-count display.
 * @param {Array<object>|null} [props.parsedDuplicates=null] - Intra-file duplicates. null = feature does not use duplicate detection.
 * @param {string|null}   [props.parseError=null]    - Client-side header or parse error message.
 * @param {string[]}      [props.headersMissing=[]]  - Missing required column names.
 * @param {string|null}   props.fileError            - File type or size validation error.
 * @param {boolean}       props.shaking              - When true, applies ANIMATE_SHAKE to the dropzone.
 * @param {boolean}       props.verifying            - True while the verify request is in flight.
 * @param {number}        props.maxFileSize          - Maximum accepted file size in bytes.
 * @param {Function}      props.onShakingEnd         - Resets the shaking flag (onAnimationEnd handler).
 * @param {Function}      props.onFile               - Called with the dropped or selected File object.
 * @param {Function}      props.onRemoveFile         - Clears the selected file.
 * @param {Function}      props.onProceed            - Triggers the verify step.
 * @param {Function}      props.onDownloadTemplate   - Generates and downloads the sample .xlsx template.
 * @param {Function}      props.formatFileSize       - Formats a byte count to a human-readable string.
 * @param {string[]}      [props.requiredHeaders=[]] - Required header names shown in the info panel.
 * @param {string}        [props.dropzoneLabel]      - Idle label inside the dropzone.
 * @param {string}        [props.proceedLabel]       - Text on the Proceed button.
 */
export function ExcelStepDropzone({ uploadFile, parsedRows = [], parsedDuplicates = null, parseError = null, headersMissing = [], fileError, shaking, verifying, maxFileSize, onShakingEnd, onFile, onRemoveFile, onProceed, onDownloadTemplate, formatFileSize, requiredHeaders = [], dropzoneLabel = "Drag & drop your Excel file here", proceedLabel = "Proceed to Verify Data" }) {
    const onDrop = useCallback(
        (accepted) => {
            const f = accepted[0];
            if (f) onFile(f);
        },
        [onFile],
    );

    const { getRootProps, getInputProps, isDragActive } = useDropzone({
        onDrop,
        accept: {
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
            "application/vnd.ms-excel": [".xls"],
        },
        maxSize: maxFileSize,
        multiple: false,
    });

    const hasDuplicates = Array.isArray(parsedDuplicates) && parsedDuplicates.length > 0;
    const canProceed = !!uploadFile && parsedRows.length > 0 && !parseError && headersMissing.length === 0 && !hasDuplicates && !fileError;

    return (
        <div className={`space-y-6 ${ANIMATE_FADE_IN_UP}`}>
            {/* Requirements info panel */}
            <div className="p-4 rounded-lg bg-blue-50 dark:bg-blue-400/10 border border-blue-400/30 flex items-start gap-3">
                <FontAwesomeIcon icon={faFileExcel} className="text-(--blue-foreground) text-xl mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                    <p className="font-aumovio-bold text-(--blue-foreground) mb-1">Required Excel Columns</p>
                    {requiredHeaders.length > 0 && (
                        <p className="text-sm text-(--blue-foreground)">
                            Your file must contain: <span className="font-aumovio-bold font-mono">{requiredHeaders.join(", ")}</span>
                        </p>
                    )}
                    <div className="mt-2">
                        <Button size="xs" variant="ghost" onClick={onDownloadTemplate} type="button">
                            <FontAwesomeIcon icon={faFileExcel} className="mr-1" />
                            Download Sample Template
                        </Button>
                    </div>
                </div>
            </div>

            {/* Drop zone */}
            <div
                {...getRootProps()}
                onAnimationEnd={onShakingEnd}
                aria-label="File upload area"
                className={`border-2 border-dashed rounded-xl p-16 text-center cursor-pointer select-none
                    ${TRANSITION_COLORS}
                    ${shaking ? `${ANIMATE_SHAKE} border-danger-400 bg-danger-100/10 dark:bg-danger-400/5` : ""}
                    ${isDragActive && !shaking ? "border-orange-400 bg-orange-50 dark:bg-orange-400/5 scale-[1.01] shadow-lg" : ""}
                    ${!isDragActive && !shaking ? "border-orange-200 dark:border-orange-400/30 hover:border-orange-400 hover:bg-orange-50 dark:hover:bg-orange-400/5" : ""}`}
            >
                <input {...getInputProps()} />
                <div className="flex flex-col items-center gap-3">
                    <div className={`p-4 rounded-full ${isDragActive ? "bg-orange-100 dark:bg-orange-400/20" : "bg-grey-100 dark:bg-(--bg-surface-3)"} ${TRANSITION_COLORS}`}>
                        <CloudArrowUpIcon className={`w-8 h-8 ${isDragActive ? "text-(--accent-icon)" : "text-grey-400"} ${TRANSITION_COLORS}`} />
                    </div>
                    {isDragActive ? (
                        <p className="text-lg font-aumovio-bold text-(--accent-foreground)">Drop your Excel file here...</p>
                    ) : (
                        <div className="space-y-1">
                            <p className={`text-lg ${TITLE_COLOR_TEXT}`}>{dropzoneLabel}</p>
                            <p className="text-black/50 dark:text-white/50">
                                or <span className="text-(--accent-foreground) font-aumovio-bold hover:underline">click to select</span>
                            </p>
                            <p className="text-black/40 dark:text-white/40 text-sm">Supports .xlsx and .xls · Max {formatFileSize(maxFileSize)}</p>
                        </div>
                    )}
                </div>
            </div>

            {/* File type / size error */}
            {fileError && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-danger-100 dark:bg-danger-400/10 border border-danger-400/30 text-danger-400 text-sm">
                    <FontAwesomeIcon icon={faExclamationTriangle} className="shrink-0" />
                    {fileError}
                </div>
            )}

            {/* File info card */}
            {uploadFile && (
                <div className="p-4 rounded-lg bg-success-100/20 dark:bg-success-400/10 border border-success-400/30 flex items-start gap-4">
                    <FontAwesomeIcon icon={faFileExcel} className="text-2xl text-success-400 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                        <p className="font-aumovio-bold text-black/85 dark:text-white/85 truncate">{uploadFile.name}</p>
                        <p className="text-sm text-black/50 dark:text-white/50 mt-0.5">
                            {formatFileSize(uploadFile.size)} · Modified: {new Date(uploadFile.lastModified).toLocaleString()}
                        </p>

                        {parseError && (
                            <p className="mt-2 text-sm text-danger-400">
                                <FontAwesomeIcon icon={faExclamationTriangle} className="mr-1" />
                                {parseError}
                            </p>
                        )}

                        {headersMissing.length > 0 && (
                            <div className="mt-2 p-3 bg-danger-100 dark:bg-danger-400/10 rounded border border-danger-400/30">
                                <p className="text-sm font-aumovio-bold text-danger-400">Missing required columns:</p>
                                <p className="text-sm text-danger-400/80">{headersMissing.join(", ")}</p>
                            </div>
                        )}

                        {!parseError && !headersMissing.length && parsedRows.length > 0 && (
                            <div className="mt-2 flex items-center gap-2">
                                <FontAwesomeIcon icon={hasDuplicates ? faExclamationTriangle : faCheckCircle} className={hasDuplicates ? "text-warn-400" : "text-success-400"} />
                                <span className={`text-sm font-aumovio-bold ${hasDuplicates ? "text-warn-500 dark:text-warn-400" : "text-success-400"}`}>
                                    {parsedRows.length} row{parsedRows.length !== 1 ? "s" : ""} read
                                    {hasDuplicates ? ` · ${parsedDuplicates.length} duplicate value${parsedDuplicates.length !== 1 ? "s" : ""} detected` : " · no duplicates found"}
                                </span>
                            </div>
                        )}

                        {!parseError && !headersMissing.length && parsedRows.length === 0 && !fileError && uploadFile && (
                            <div className="mt-2 flex items-center gap-2">
                                <FontAwesomeIcon icon={faCheckCircle} className="text-success-400" />
                                <span className="text-sm font-aumovio-bold text-success-400">File ready for verification</span>
                            </div>
                        )}
                    </div>
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onRemoveFile();
                        }}
                        type="button"
                        aria-label="Remove file"
                        className={`text-grey-400 hover:text-danger-400 ${TRANSITION_COLORS} p-1 rounded`}
                    >
                        <FontAwesomeIcon icon={faXmark} className="text-lg" />
                    </button>
                </div>
            )}

            {/* Intra-file duplicate warning — shown only when parsedDuplicates is non-null */}
            {parsedDuplicates !== null && !parseError && !headersMissing.length && hasDuplicates && (
                <div className="p-4 rounded-lg bg-warn-100/50 dark:bg-warn-400/10 border border-warn-400/30">
                    <div className="flex items-start gap-3">
                        <FontAwesomeIcon icon={faExclamationTriangle} className="text-warn-500 dark:text-warn-400 text-lg shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0">
                            <p className="font-aumovio-bold text-warn-700 dark:text-warn-300 mb-1">
                                {parsedDuplicates.length} duplicate value{parsedDuplicates.length !== 1 ? "s" : ""} found in file
                            </p>
                            <p className="text-sm text-warn-600 dark:text-warn-400/80 mb-3">The rows below share the same value for a field that must be unique. Please have HR review and correct the file before uploading — you cannot proceed until all duplicates are resolved.</p>
                            <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
                                {parsedDuplicates.map(({ field, value, rowIndices }) => (
                                    <div key={`${field}-${value}`} className="flex items-start gap-2 text-sm text-warn-700 dark:text-warn-300">
                                        <FontAwesomeIcon icon={faExclamationCircle} className="text-xs mt-1 shrink-0 opacity-70" />
                                        <span>
                                            Rows <span className="font-aumovio-bold">{rowIndices.map((i) => i + 1).join(", ")}</span> share the same <span className="font-aumovio-bold font-mono">{field}</span>: <span className="font-mono bg-warn-100 dark:bg-warn-400/10 px-1 py-0.5 rounded text-base">{String(value)}</span>
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Proceed button */}
            {(canProceed || verifying) && (
                <div className="flex justify-end">
                    <Button variant="primary" onClick={onProceed} disabled={!canProceed || verifying} loading={verifying} type="button" size="md">
                        {!verifying && <FontAwesomeIcon icon={faCheck} />}
                        {verifying ? "Verifying..." : proceedLabel}
                    </Button>
                </div>
            )}
        </div>
    );
}

ExcelStepDropzone.propTypes = {
    uploadFile: PropTypes.object,
    parsedRows: PropTypes.array,
    parsedDuplicates: PropTypes.array,
    parseError: PropTypes.string,
    headersMissing: PropTypes.arrayOf(PropTypes.string),
    fileError: PropTypes.string,
    shaking: PropTypes.bool,
    verifying: PropTypes.bool,
    maxFileSize: PropTypes.number,
    onShakingEnd: PropTypes.func,
    onFile: PropTypes.func,
    onRemoveFile: PropTypes.func,
    onProceed: PropTypes.func,
    onDownloadTemplate: PropTypes.func,
    formatFileSize: PropTypes.func,
    requiredHeaders: PropTypes.arrayOf(PropTypes.string),
    dropzoneLabel: PropTypes.string,
    proceedLabel: PropTypes.string,
};

export default ExcelStepDropzone;
