// @ts-check
'use strict';
/** An error the RPC caller sees with its code (ERRORS in protocol.js). Core re-exports it. */
class RpcError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
module.exports = { RpcError };
