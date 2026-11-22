/**
 * One query-string parameter as a plain string.
 *
 * Express parses `?a=1&a=2` into an array and `?a[b]=1` into an object. Every
 * query parameter this API reads is single-valued, so those shapes are treated
 * as absent (undefined) rather than handed to a service that expects a string.
 *
 * @param {unknown} value - a `req.query` entry
 * @returns {string|undefined}
 */
function queryString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

export { queryString };
