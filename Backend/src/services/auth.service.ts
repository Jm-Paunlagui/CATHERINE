

// Legacy module path — AuthMiddleware and older suites require it; the live implementation is AuthService.js.
export default (require("./AuthService") as typeof import("./AuthService")).default;
