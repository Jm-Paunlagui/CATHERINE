import { toast as t } from "react-toastify";

export const toast = {
    success: (msg, opts) => t.success(msg, opts),
    error: (msg, opts) => t.error(msg, opts),
    warning: (msg, opts) => t.warning(msg, opts),
    info: (msg, opts) => t.info(msg, opts),
    loading: (msg, opts) => t.loading(msg, opts),
    dismiss: (id) => t.dismiss(id),
    promise: (promise, { loading, success, error }, opts) => t.promise(promise, { pending: loading, success, error }, opts),
};
