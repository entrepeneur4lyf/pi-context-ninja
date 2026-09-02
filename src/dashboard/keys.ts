/**
 * Close keys for the overlay (04-analytics-and-dashboard.md DASH-033).
 *
 * Escape arrives in three encodings depending on the terminal protocol:
 * plain ESC, kitty CSI u (`ESC [ 27 u` with an optional modifier field),
 * and xterm modifyOtherKeys (`ESC [ 27 ; mods ; 27 ~`). The host's key
 * parser sits on its native addon, so PCN matches the raw data itself.
 */
const PLAIN_ESCAPE = "\x1b";
const KITTY_ESCAPE = /^\x1b\[27(?:;\d+)?u$/;
const MODIFY_OTHER_KEYS_ESCAPE = /^\x1b\[27;\d+;27~$/;

export function isOverlayCloseKey(data: string): boolean {
  if (data === PLAIN_ESCAPE || data === "q") {
    return true;
  }
  return KITTY_ESCAPE.test(data) || MODIFY_OTHER_KEYS_ESCAPE.test(data);
}
