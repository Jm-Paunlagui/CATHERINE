/**
 * FileInput — Styled file picker with drag-and-drop.
 *
 * Props:
 *   label, name, accept, multiple, disabled
 *   onChange    — (files: FileList) => void
 *   maxSize     — bytes (for validation hint)
 *   preview     — boolean (image thumbnails)
 *   dropzone    — boolean (full drop zone variant)
 *   error
 */
import { CloudArrowUpIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useRef, useState } from "react";
import { TRANSITION_COLORS, TRANSITION_SMOOTH } from "../../assets/styles/pre-set-styles";

export function FileInput({ label, name, accept, multiple = false, disabled = false, onChange, maxSize, error, preview = false, dropzone = true }) {
    const ref = useRef(null);
    const [files, setFiles] = useState([]);
    const [dragging, setDragging] = useState(false);

    const handle = (incoming) => {
        const arr = Array.from(incoming);
        setFiles(multiple ? arr : arr.slice(0, 1));
        onChange?.(incoming);
    };

    const removeFile = (i) => {
        const next = files.filter((_, fi) => fi !== i);
        setFiles(next);
        onChange?.(next);
    };

    if (!dropzone)
        return (
            <div className="font-aumovio">
                {label && <label className="block text-xs font-aumovio-bold text-black/70 dark:text-white/70 mb-1.5">{label}</label>}
                <input
                    type="file"
                    name={name}
                    accept={accept}
                    multiple={multiple}
                    disabled={disabled}
                    onChange={(e) => handle(e.target.files)}
                    className={`block w-full text-sm text-grey-500 dark:text-grey-400 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:font-aumovio-bold file:text-xs file:bg-orange-400/10 file:text-(--accent-foreground) hover:file:bg-orange-400 hover:file:text-(--on-accent-text) file:cursor-pointer ${TRANSITION_COLORS}`}
                />
            </div>
        );

    return (
        <div className="font-aumovio">
            {label && <label className="block text-xs font-aumovio-bold text-black/70 dark:text-white/70 mb-1.5">{label}</label>}
            <div
                onClick={() => !disabled && ref.current?.click()}
                onDragOver={(e) => {
                    e.preventDefault();
                    !disabled && setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    handle(e.dataTransfer.files);
                }}
                className={`relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer
          ${TRANSITION_SMOOTH}
          ${disabled ? "opacity-50 cursor-not-allowed" : ""}
          ${error ? "border-danger-400 bg-danger-100/10" : ""}
          ${dragging ? "border-orange-400 bg-orange-50 dark:bg-orange-400/5 scale-[1.01]" : error ? "" : "border-grey-300 dark:border-grey-700 hover:border-orange-400 bg-white dark:bg-(--bg-surface-2)"}`}
            >
                <input ref={ref} type="file" name={name} accept={accept} multiple={multiple} className="sr-only" onChange={(e) => handle(e.target.files)} />
                <CloudArrowUpIcon className="w-10 h-10 mx-auto mb-3 text-grey-300 dark:text-grey-600" />
                <p className="text-sm font-aumovio-bold text-black/60 dark:text-white/60">
                    Drop files here or <span className="text-(--accent-foreground)">browse</span>
                </p>
                {accept && <p className="mt-1 text-xs text-grey-400">Accepted: {accept}</p>}
                {maxSize && <p className="text-xs text-grey-400">Max size: {(maxSize / 1024 / 1024).toFixed(1)} MB</p>}
            </div>
            {files.length > 0 && (
                <ul className="mt-3 space-y-2">
                    {files.map((f, i) => (
                        <li key={i} className="flex items-center gap-2 px-3 py-2 text-sm border rounded-lg bg-grey-50 dark:bg-(--bg-surface-3) border-grey-200 dark:border-grey-700">
                            {preview && f.type.startsWith("image/") && <img src={URL.createObjectURL(f)} className="object-cover w-8 h-8 rounded" alt="" />}
                            <span className="flex-1 truncate text-black/70 dark:text-white/70">{f.name}</span>
                            <span className="text-xs text-grey-400 shrink-0">{(f.size / 1024).toFixed(0)} KB</span>
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    removeFile(i);
                                }}
                                className="transition-colors text-grey-400 hover:text-danger-400"
                            >
                                <XMarkIcon className="w-4 h-4" />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {error && <p className="mt-1.5 text-xs text-danger-400 font-aumovio-bold">{error}</p>}
        </div>
    );
}

export default FileInput;
