/**
 * Content-Security-Policy additions merged over helmet defaults
 * (helmet merges `directives` into its default policy).
 *
 * `wasm-unsafe-eval` on script-src is required for WebAssembly.compile,
 * which the RNNoise Enhanced mode needs. Without it the production build
 * (served by Caddy, where no dev-server laxness applies) would fail to
 * load the suppressor while `vite dev` keeps working — hence the unit test
 * below pinning this value.
 */
export function contentSecurityPolicyDirectives(): Record<string, string[]> {
  return {
    "script-src": ["'self'", "'wasm-unsafe-eval'"],
  };
}
