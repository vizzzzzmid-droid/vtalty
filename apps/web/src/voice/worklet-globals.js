/**
 * AudioWorklet polyfill, loaded BEFORE any third-party worklet module.
 *
 * `AudioWorkletGlobalScope` is NOT a `Window` and not a full `Worker`: it
 * exposes a very small global set, and `TextDecoder`/`TextEncoder` are NOT
 * part of it (they are only in DedicatedWorker/Window scopes). The
 * DeepFilterNet3 build is emscripten glue, which instantiates
 * `new TextDecoder(...)` at module top level, so `audioWorklet.addModule()`
 * for the DeepFilter worklet fails with
 * `ReferenceError: TextDecoder is not defined` and no processor is ever
 * registered — the mic chain then never gets a track and joining the voice
 * channel fails.
 *
 * Globals set here persist in the same AudioWorkletGlobalScope, so calling
 * `addModule()` again for the real worklet afterwards succeeds. Both addModule
 * calls must target the same context.
 *
 * This file is intentionally plain ES5-ish JavaScript (no TypeScript): it is
 * imported with Vite `?url`, so it is emitted verbatim as a worklet asset and
 * is never run through the TS/ESM pipeline.
 */
(function () {
  var g = globalThis;
  if (typeof g.TextDecoder !== "function") {
    g.TextDecoder = function TextDecoder(encoding, options) {
      var ignoreBOM = !!(options && options.ignoreBOM);
      var fatal = !!(options && options.fatal);
      var fatalError = function () {
        var err = new TypeError("Invalid UTF-8 sequence in TextDecoder input");
        err.name = "TypeError";
        throw err;
      };
      this.decode = function (bytes) {
        if (bytes === undefined) {
          return "";
        }
        var out = "";
        var start = ignoreBOM && bytes.length >= 3 &&
          bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
        for (var i = start; i < bytes.length;) {
          var b0 = bytes[i];
          var code;
          var extra;
          if (b0 < 0x80) {
            code = b0;
            extra = 0;
          } else if ((b0 & 0xe0) === 0xc0) {
            code = b0 & 0x1f;
            extra = 1;
          } else if ((b0 & 0xf0) === 0xe0) {
            code = b0 & 0x0f;
            extra = 2;
          } else if ((b0 & 0xf8) === 0xf0) {
            code = b0 & 0x07;
            extra = 3;
          } else {
            if (fatal) {
              fatalError();
            }
            out += "�";
            i += 1;
            continue;
          }
          if (i + extra >= bytes.length) {
            if (fatal) {
              fatalError();
            }
            out += "�";
            i += 1;
            continue;
          }
          var valid = true;
          for (var k = 1; k <= extra; k += 1) {
            var bk = bytes[i + k];
            if (bk === undefined || (bk & 0xc0) !== 0x80) {
              valid = false;
              break;
            }
            code = (code << 6) | (bk & 0x3f);
          }
          if (!valid) {
            if (fatal) {
              fatalError();
            }
            out += "�";
            i += 1;
            continue;
          }
          out += String.fromCodePoint
            ? String.fromCodePoint(code)
            : String.fromCharCode(code);
          i += extra + 1;
        }
        return out;
      };
    };
  }
  if (typeof g.TextEncoder !== "function") {
    g.TextEncoder = function TextEncoder() {
      this.encode = function (input) {
        var str = String(input);
        var bytes = [];
        for (var i = 0; i < str.length; i += 1) {
          var code = str.codePointAt(i);
          if (code > 0xffff) {
            i += 1;
          }
          if (code < 0x80) {
            bytes.push(code);
          } else if (code < 0x800) {
            bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
          } else if (code < 0x10000) {
            bytes.push(
              0xe0 | (code >> 12),
              0x80 | ((code >> 6) & 0x3f),
              0x80 | (code & 0x3f),
            );
          } else {
            bytes.push(
              0xf0 | (code >> 18),
              0x80 | ((code >> 12) & 0x3f),
              0x80 | ((code >> 6) & 0x3f),
              0x80 | (code & 0x3f),
            );
          }
        }
        return new Uint8Array(bytes);
      };
    };
  }
})();
